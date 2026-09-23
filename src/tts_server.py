"""Skadi's natural voice: a tiny local HTTP server around Kyutai's Pocket TTS.

Runs on the CPU so it never competes with the language model for VRAM.

  GET  /health               -> {"ok": true, "sampleRate": 24000}
  POST /speak {text, voice}  -> raw 16-bit mono PCM, streamed as it is made

Streaming is what makes it sound fluid: the first words play about a quarter
of a second after the request instead of after the whole reply is rendered.

`voice` is a built-in voice name ("alba") or a path to a WAV sample to clone.
A sample is converted once into a .safetensors file beside it, which loads in
milliseconds next time. Cloning needs the gated model weights (accept the
terms at huggingface.co/kyutai/pocket-tts and give Skadi a token); without
them the built-in voices still work.
"""
import argparse
import json
import os
import sys
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()

from pocket_tts import TTSModel  # noqa: E402  (after argparse so --help is fast)

try:
    from pocket_tts import export_model_state
except ImportError:  # older releases
    export_model_state = None

model = TTSModel.load_model()
lock = threading.Lock()
states = {}
GATED_HINT = ("Cloning a voice needs Kyutai's gated model: accept its terms at "
              "https://huggingface.co/kyutai/pocket-tts, add a Hugging Face token in "
              "Skadi's voice settings, then restart the voice engine.")


def voice_state(voice):
    voice = voice or "alba"
    key = f"{voice}:{os.path.getmtime(voice)}" if os.path.isfile(voice) else voice
    if key in states:
        return states[key]
    source = voice
    cache = voice + ".safetensors"
    if os.path.isfile(voice) and os.path.isfile(cache) and os.path.getmtime(cache) >= os.path.getmtime(voice):
        source = cache
    state = model.get_state_for_audio_prompt(source)
    if source == voice and os.path.isfile(voice) and export_model_state:
        try:
            export_model_state(state, cache)
        except Exception as err:  # the cache is only a speed-up
            print(f"[tts] could not cache voice: {err}", file=sys.stderr, flush=True)
    states[key] = state
    return state


def pcm(chunk):
    return (chunk.detach().cpu().float().clamp(-1, 1).numpy() * 32767).astype("<i2").tobytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, code, body):
        body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "sampleRate": model.sample_rate})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            return self.reply(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            text = str(body.get("text") or "").strip()[:4000]
            if not text:
                return self.reply(400, {"error": "text is required"})
            lock.acquire()
            try:
                state = voice_state(body.get("voice"))
            except Exception as err:
                lock.release()
                message = str(err)
                if "voice cloning" in message.lower() or "gated" in message.lower():
                    message = GATED_HINT
                return self.reply(422, {"error": message})
            stop = threading.Event()
            try:
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("x-sample-rate", str(model.sample_rate))
                self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                for chunk in model.generate_audio_stream(state, text, stop=stop):
                    data = pcm(chunk)
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                stop.set()  # the listener interrupted; stop making sound nobody hears
            finally:
                lock.release()
        except Exception as err:
            try:
                self.reply(500, {"error": str(err)})
            except Exception:
                pass


server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
print("READY", flush=True)
server.serve_forever()
