// Skadi.exe -- the application shell.
//
// A frameless WinForms window hosting WebView2, so the title bar is part of the
// interface rather than something Windows draws above it: the window controls
// live in Skadi's own top bar, next to the project and provider pickers.
//
// The caption is removed by handling WM_NCCALCSIZE and putting the default
// client rectangle's top back where it was. That strips the title bar while
// leaving the left, right and bottom borders as non-client area, so native
// resizing, Aero Snap, the drop shadow and the maximise animation all keep
// working. The top edge is client area now, so the page reports a press on its
// top few pixels and the shell starts the same native resize from there. Dragging is a real WM_NCLBUTTONDOWN, not a mouse-move loop, so snap
// layouts behave exactly as they do for any other window.
//
// If WebView2 is unavailable the shell falls back to a Chromium --app window,
// which loses the integrated title bar but still runs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Native
{
    public const int WM_NCCALCSIZE = 0x0083;
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 2;
    public const int HTTOP = 12;
    public const int HTTOPLEFT = 13;
    public const int HTTOPRIGHT = 14;

    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    public const int SM_CYFRAME = 33;
    public const int SM_CXPADDEDBORDER = 92;

    // PER_MONITOR_AWARE_V2: crisp on mixed-DPI setups, and the non-client
    // metrics we depend on scale correctly.
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct NCCALCSIZE_PARAMS
    {
        public RECT rgrc0, rgrc1, rgrc2;
        public IntPtr lppos;
    }
}

class ShellForm : Form
{
    readonly WebView2 view = new WebView2();
    readonly string url;
    readonly Process server;
    readonly bool ownsServer;
    readonly EventWaitHandle activateEvent;
    readonly System.Windows.Forms.Timer activateTimer = new System.Windows.Forms.Timer();

    public ShellForm(string url, Process server, bool ownsServer, string appName, EventWaitHandle activateEvent)
    {
        this.url = url;
        this.server = server;
        this.ownsServer = ownsServer;
        this.activateEvent = activateEvent;

        Text = appName;
        // Sizable, not None: we want the native resize borders and the shadow.
        // The caption is removed in WndProc instead.
        FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1440, 920);
        MinimumSize = new Size(900, 560);
        // Black: the frame only shows while resizing, and any tint reads as a
        // coloured border on the OLED theme.
        BackColor = Color.Black;
        DoubleBuffered = true;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName);
        }
        catch (Exception) { /* the window just uses the default icon */ }

        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.Black;
        Controls.Add(view);

        Load += async (s, e) => await Start();
        // Asked first, so the server can stop what was started from it; forced
        // only if it does not go. An adopted server is asked too: the job
        // would kill it the moment this process exits anyway.
        FormClosed += (s, e) =>
        {
            foreach (PetWindow pet in new List<PetWindow>(pets.Values)) pet.Close();
            bool stopped = Shell.StopGracefully(new Uri(url).Port, ownsServer ? server : null, 10000);
            if (ownsServer && !stopped) Shell.KillTree(server);
        };

        // A later Skadi.exe launch signals this event instead of creating a
        // second shell. Polling on the UI thread keeps all window operations
        // on their owning thread, and a signal sent during startup remains set
        // until this window is ready to consume it.
        activateTimer.Interval = 200;
        activateTimer.Tick += (s, e) =>
        {
            if (this.activateEvent == null || !this.activateEvent.WaitOne(0)) return;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show();
            BringToFront();
            Activate();
        };
        activateTimer.Start();
    }

    async Task Start()
    {
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Skadi", "webview2");
        Directory.CreateDirectory(dataDir);

        var env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
        await view.EnsureCoreWebView2Async(env);

        var core = view.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = true; // keep F12 and reload

        // The page's own right-click menu offers Paste, which reads the
        // clipboard. Allow that for Skadi's page without a browser prompt.
        core.PermissionRequested += (s, e) =>
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead)
                e.State = CoreWebView2PermissionState.Allow;
        };

        // The page names itself (document.title); the taskbar follows.
        core.DocumentTitleChanged += (s, e) =>
        {
            string title = core.DocumentTitle;
            if (!string.IsNullOrEmpty(title)) Text = title;
        };

        // Window commands arrive from the page's own title bar; desktop dwarves
        // from Mission Control.
        core.WebMessageReceived += (s, e) =>
        {
            string body;
            try { body = e.TryGetWebMessageAsString(); }
            catch (Exception) { return; }
            if (body != null && body.StartsWith("pet:")) OnPetCommand(body);
            else OnWindowCommand(body);
        };

        // Links that would open a new window go to the user's real browser.
        core.NewWindowRequested += (s, e) =>
        {
            e.Handled = true;
            try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
            catch (Exception) { /* nothing useful to do */ }
        };

        // Tell the page it is running inside the shell, so it shows its own
        // window controls instead of assuming a browser tab.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "window.__SKADI_SHELL__ = true;" +
            // Desktop dwarves (PetWindow): older shells ignore the messages.
            "window.__SKADI_PETS__ = 1;" +
            "window.skadiWindow = {" +
            "  minimize: () => window.chrome.webview.postMessage('minimize')," +
            "  toggleMaximize: () => window.chrome.webview.postMessage('maximize')," +
            "  close: () => window.chrome.webview.postMessage('close')," +
            "  drag: () => window.chrome.webview.postMessage('drag')," +
            "  resize: (edge) => window.chrome.webview.postMessage('resize:' + edge)" +
            "};");

        core.Navigate(url);
        SyncMaximizeState();
    }

    void OnWindowCommand(string command)
    {
        switch (command)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "maximize":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal : FormWindowState.Maximized;
                SyncMaximizeState();
                break;
            case "close":
                Close();
                break;
            case "drag":
                // Hand the drag to Windows so Aero Snap and multi-monitor
                // behaviour are the real thing, not an approximation.
                Native.ReleaseCapture();
                Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
                break;
            case "resize:top":
                BeginTopResize(Native.HTTOP);
                break;
            case "resize:topleft":
                BeginTopResize(Native.HTTOPLEFT);
                break;
            case "resize:topright":
                BeginTopResize(Native.HTTOPRIGHT);
                break;
        }
    }

    // Dwarves on the desktop, by agent id. Not owned by this form: an owned
    // window hides whenever its owner is minimised, and a desktop dwarf is
    // meant to stay out while Skadi is tucked away.
    readonly Dictionary<string, PetWindow> pets = new Dictionary<string, PetWindow>();

    // pet:show|id|name|status|state|x|y|resting scene|busy scene
    // pet:update|id|status|state      pet:hide|id
    // Text is URI-encoded; a scene is "png~ms,png~ms,...;loop" (see Frames).
    void OnPetCommand(string body)
    {
        string[] p = body.Split('|');
        if (p.Length < 2 || p[1].Length == 0) return;
        string id = p[1];
        PetWindow pet;
        pets.TryGetValue(id, out pet);
        try
        {
            switch (p[0])
            {
                case "pet:show":
                    if (p.Length < 9) return;
                    if (pet == null)
                    {
                        pet = new PetWindow(id, SendToPage, ShowShell);
                        pet.FormClosed += (s, e) => pets.Remove(id);
                        pets[id] = pet;
                    }
                    pet.Apply(Uri.UnescapeDataString(p[2]), Uri.UnescapeDataString(p[3]), p[4],
                        PetWindow.Frames(p[7]), PetWindow.Frames(p[8]));
                    if (!pet.Visible) pet.ShowAt(ParseInt(p[5]), ParseInt(p[6]), pets.Count - 1);
                    break;
                case "pet:update":
                    if (pet != null && p.Length >= 4) pet.SetStatus(Uri.UnescapeDataString(p[2]), p[3]);
                    break;
                case "pet:hide":
                    if (pet != null) pet.Remove(false);
                    break;
            }
        }
        catch (Exception) { /* a malformed message changes nothing */ }
    }

    static int? ParseInt(string s)
    {
        int n;
        return int.TryParse(s, out n) ? (int?)n : null;
    }

    void SendToPage(string message)
    {
        try { if (view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsString(message); }
        catch (Exception) { /* the page is reloading; it re-sends its dwarves */ }
    }

    void ShowShell()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        BringToFront();
        Activate();
    }

    // The top border was handed to the client area (see WndProc), so the page
    // reports a press on its top edge and Windows runs its own sizing loop.
    // The sizing loop measures from the press point, so pass the real cursor
    // position rather than zero or the window would jump.
    void BeginTopResize(int hit)
    {
        if (WindowState != FormWindowState.Normal) return;
        Point p = Cursor.Position;
        IntPtr pos = (IntPtr)((p.Y << 16) | (p.X & 0xFFFF));
        Native.ReleaseCapture();
        Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)hit, pos);
    }

    void SyncMaximizeState()
    {
        // A maximised window with WS_THICKFRAME hangs its frame off the edge of
        // the monitor. Windows already keeps the sides and bottom in view (they
        // stay non-client); only the top, which WM_NCCALCSIZE gave to the
        // client area, needs pulling back in. Padding the other sides too left
        // a strip of the form's background around the page.
        Padding = WindowState == FormWindowState.Maximized
            ? new Padding(0, MaximizedTopInset(), 0, 0) : new Padding(0);

        if (view.CoreWebView2 != null)
        {
            string maximized = WindowState == FormWindowState.Maximized ? "true" : "false";
            try
            {
                view.CoreWebView2.ExecuteScriptAsync(
                    "document.documentElement.classList.toggle('is-maximized', " + maximized + ")");
            }
            catch (Exception) { /* the page may not be loaded yet */ }
        }
    }

    int MaximizedTopInset()
    {
        try
        {
            uint dpi = Native.GetDpiForWindow(Handle);
            if (dpi == 0) dpi = 96;
            return Native.GetSystemMetricsForDpi(Native.SM_CYFRAME, dpi)
                 + Native.GetSystemMetricsForDpi(Native.SM_CXPADDEDBORDER, dpi);
        }
        catch (Exception) { return 8; } // Windows 10 before 1607
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        SyncMaximizeState();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            var original = (Native.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(
                m.LParam, typeof(Native.NCCALCSIZE_PARAMS));
            int originalTop = original.rgrc0.Top;

            base.WndProc(ref m);

            // Let Windows compute the borders, then give the caption's height
            // back to the client area. Side and bottom borders stay non-client,
            // which is what keeps native resizing alive.
            var adjusted = (Native.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(
                m.LParam, typeof(Native.NCCALCSIZE_PARAMS));
            adjusted.rgrc0.Top = originalTop;
            Marshal.StructureToPtr(adjusted, m.LParam, false);
            return;
        }
        base.WndProc(ref m);
    }
}

// A Mission Control dwarf on the desktop: a small window that stays on top of
// everything and shows one agent and what it is doing. The page draws the
// sprite frames (the art lives there) and this window only shows them. It is a
// per-pixel-alpha layered window, so the dwarf stands on the desktop with no
// box around it and clicks on its empty pixels reach whatever is underneath.
// Drag to move, double-click to open its chat, right-click for a menu.
class PetWindow : Form
{
    [StructLayout(LayoutKind.Sequential)]
    struct PT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct SZ { public int W, H; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct BLEND { public byte Op, Flags, Alpha, Format; }

    [DllImport("user32.dll")]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref PT pptDst, ref SZ psize,
        IntPtr hdcSrc, ref PT pptSrc, int crKey, ref BLEND pblend, int dwFlags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_TOPMOST = 0x8;
    const int ULW_ALPHA = 2;

    public readonly string Id;
    readonly Action<string> send;
    readonly Action showShell;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly ToolStripMenuItem openItem = new ToolStripMenuItem();
    // Resting (the campfire scene) and busy (working, or in trouble).
    Sequence idle = Sequence.Empty, busy = Sequence.Empty;
    Sequence playing = null;
    int frame;
    DateTime frameUntil;
    string petName = "", status = "", state = "idle", drawn = null;
    // Where the window is and how wide it was last drawn. UpdateLayeredWindow
    // moves and sizes the window itself, so these are kept here rather than
    // read back from the form's cached bounds.
    int px, py, pw;
    bool pressed, dragged, removing;
    Point press;
    DateTime lastClick = DateTime.MinValue;

    public PetWindow(string id, Action<string> send, Action showShell)
    {
        Id = id;
        this.send = send;
        this.showShell = showShell;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        MaximizeBox = false;
        MinimizeBox = false;

        openItem.Click += (s, e) => Open();
        var mission = new ToolStripMenuItem("Open Mission Control");
        mission.Click += (s, e) => { showShell(); send("pet:mission|" + Id); };
        var remove = new ToolStripMenuItem("Remove from desktop");
        remove.Click += (s, e) => Remove(true);
        menu.Items.AddRange(new ToolStripItem[] { openItem, mission, new ToolStripSeparator(), remove });

        // Frames carry their own durations; the timer only checks whether the
        // current one is up, and nothing is redrawn while it is not.
        timer.Interval = 50;
        timer.Tick += (s, e) => Redraw();
        timer.Start();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
            return cp;
        }
    }

    /// An animation: frames with how long each shows, played once from the
    /// start and then looped from `Loop` -- so a scene can set itself up
    /// (build the fire) and then idle in place (read by it).
    public class Sequence
    {
        public static readonly Sequence Empty = new Sequence(new Bitmap[0], new int[0], 0);
        public readonly Bitmap[] Frames;
        public readonly int[] Ms;
        public readonly int Loop;
        public Sequence(Bitmap[] frames, int[] ms, int loop)
        {
            Frames = frames;
            Ms = ms;
            Loop = Math.Max(0, Math.Min(loop, Math.Max(0, frames.Length - 1)));
        }
        public void Dispose() { foreach (Bitmap b in Frames) b.Dispose(); }
    }

    /// "png~ms,png~ms,...;loop" -- PNG base64, how long it shows, where the loop starts.
    public static Sequence Frames(string spec)
    {
        string[] halves = spec.Split(';');
        var frames = new List<Bitmap>();
        var ms = new List<int>();
        foreach (string item in halves[0].Split(','))
        {
            if (item.Length == 0) continue;
            string[] parts = item.Split('~');
            int duration;
            if (parts.Length < 2 || !int.TryParse(parts[1], out duration)) duration = 400;
            using (var stream = new MemoryStream(Convert.FromBase64String(parts[0])))
            using (var img = Image.FromStream(stream))
                frames.Add(new Bitmap(img));
            ms.Add(Math.Max(40, duration));
        }
        int loop = 0;
        if (halves.Length > 1) int.TryParse(halves[1], out loop);
        return new Sequence(frames.ToArray(), ms.ToArray(), loop);
    }

    public void Apply(string name, string status, string state, Sequence idle, Sequence busy)
    {
        this.idle.Dispose();
        this.busy.Dispose();
        petName = name;
        this.idle = idle;
        this.busy = busy;
        playing = null; // new art: start its scene from the top
        openItem.Text = "Open " + name;
        drawn = null;
        SetStatus(status, state);
    }

    public void SetStatus(string status, string state)
    {
        this.status = status;
        this.state = state;
        Redraw();
    }

    /// First appearance: where it last stood if that is still on a screen,
    /// otherwise lined up along the bottom right of the main screen.
    public void ShowAt(int? x, int? y, int index)
    {
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Point at = new Point(area.Right - 180 - index * 130, area.Bottom - 190);
        if (x.HasValue && y.HasValue)
        {
            var saved = new Point(x.Value, y.Value);
            foreach (Screen s in Screen.AllScreens)
            {
                if (s.WorkingArea.Contains(new Point(saved.X + 40, saved.Y + 40))) { at = saved; break; }
            }
        }
        px = at.X;
        py = at.Y;
        pw = 0;
        Location = at;
        Show();
        drawn = null;
        Redraw();
    }

    public void Remove(bool tellPage)
    {
        if (removing) return;
        removing = true;
        if (tellPage) send("pet:closed|" + Id);
        Close();
    }

    void Open()
    {
        showShell();
        send("pet:open|" + Id);
    }

    int SpriteScale()
    {
        uint dpi = 96;
        try { if (IsHandleCreated) dpi = Native.GetDpiForWindow(Handle); } catch (Exception) { }
        if (dpi == 0) dpi = 96;
        return Math.Max(2, (int)Math.Round(4 * dpi / 96.0));
    }

    void Redraw()
    {
        if (!IsHandleCreated || !Visible) return;
        Sequence set = state != "idle" && busy.Frames.Length > 0 ? busy : idle;
        DateTime now = DateTime.UtcNow;
        if (set != playing)
        {
            // A change of state starts that scene over: coming back to rest
            // means building the fire again.
            playing = set;
            frame = 0;
            frameUntil = set.Frames.Length > 0 ? now.AddMilliseconds(set.Ms[0]) : DateTime.MaxValue;
        }
        else if (set.Frames.Length > 1 && now >= frameUntil)
        {
            frame = frame + 1 < set.Frames.Length ? frame + 1 : set.Loop;
            frameUntil = now.AddMilliseconds(set.Ms[frame]);
        }
        int scale = SpriteScale();
        string key = frame + "|" + scale + "|" + state + "|" + status + "|" + petName + "|" + set.Frames.Length;
        if (key == drawn) return;
        drawn = key;
        using (Bitmap bmp = Compose(set.Frames.Length > 0 ? set.Frames[frame] : null, scale))
            Present(bmp);
    }

    Bitmap Compose(Bitmap frame, int scale)
    {
        float unit = scale / 4f;
        int spriteW = frame != null ? frame.Width * scale : 0;
        int spriteH = frame != null ? frame.Height * scale : 0;
        string line = status.Length > 44 ? status.Substring(0, 43) + "\u2026" : status;
        using (var nameFont = new Font("Segoe UI", 12f * unit, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var textFont = new Font("Segoe UI", 11f * unit, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var probe = new Bitmap(1, 1))
        using (var pg = Graphics.FromImage(probe))
        {
            SizeF nameSize = pg.MeasureString(petName, nameFont);
            SizeF textSize = pg.MeasureString(line, textFont);
            int pad = (int)(8 * unit), dot = (int)(7 * unit);
            int pillW = (int)Math.Ceiling(Math.Max(nameSize.Width + dot + pad / 2, textSize.Width)) + pad * 2;
            int pillH = (int)Math.Ceiling(nameSize.Height + textSize.Height) + pad;
            int w = Math.Max(spriteW, pillW) + 2, h = spriteH + pillH + 2;
            var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                if (frame != null)
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                    g.DrawImage(frame, new Rectangle((w - spriteW) / 2, 0, spriteW, spriteH));
                }
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                var pill = new RectangleF((w - pillW) / 2f, spriteH, pillW, pillH);
                using (var path = Rounded(pill, 8 * unit))
                using (var fill = new SolidBrush(Color.FromArgb(225, 24, 20, 22)))
                using (var edge = new Pen(Color.FromArgb(90, 255, 255, 255), 1))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(edge, path);
                }
                Color tone = state == "work" ? Color.FromArgb(120, 214, 120)
                    : state == "error" ? Color.FromArgb(240, 110, 100) : Color.FromArgb(150, 150, 150);
                float nx = pill.X + pad, ny = pill.Y + pad / 2f;
                using (var dotBrush = new SolidBrush(tone))
                    g.FillEllipse(dotBrush, nx, ny + (nameSize.Height - dot) / 2f, dot, dot);
                using (var ink = new SolidBrush(Color.FromArgb(245, 240, 232)))
                    g.DrawString(petName, nameFont, ink, nx + dot + pad / 2f, ny);
                using (var dim = new SolidBrush(Color.FromArgb(190, 185, 178)))
                    g.DrawString(line, textFont, dim, nx, ny + nameSize.Height);
            }
            return bmp;
        }
    }

    static System.Drawing.Drawing2D.GraphicsPath Rounded(RectangleF r, float radius)
    {
        float d = radius * 2;
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d - 1, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d - 1, r.Bottom - d - 1, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d - 1, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // Hand the finished picture to Windows. Keeps the dwarf's feet where they
    // were when the label under it grows or shrinks.
    void Present(Bitmap bmp)
    {
        if (pw > 0) px += (pw - bmp.Width) / 2;
        pw = bmp.Width;
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr hbmp = IntPtr.Zero, old = IntPtr.Zero;
        try
        {
            hbmp = bmp.GetHbitmap(Color.FromArgb(0));
            old = SelectObject(mem, hbmp);
            var size = new SZ { W = bmp.Width, H = bmp.Height };
            var src = new PT { X = 0, Y = 0 };
            var dst = new PT { X = px, Y = py };
            var blend = new BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, ULW_ALPHA);
        }
        finally
        {
            if (old != IntPtr.Zero) SelectObject(mem, old);
            if (hbmp != IntPtr.Zero) DeleteObject(hbmp);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        pressed = true;
        dragged = false;
        press = e.Location;
        Capture = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (!pressed) return;
        if (!dragged && Math.Abs(e.X - press.X) + Math.Abs(e.Y - press.Y) < 4) return;
        dragged = true;
        Point p = Cursor.Position;
        px = p.X - press.X;
        py = p.Y - press.Y;
        Location = new Point(px, py);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right)
        {
            menu.Show(this, e.Location);
            return;
        }
        if (!pressed) return;
        pressed = false;
        Capture = false;
        if (dragged)
        {
            send("pet:moved|" + Id + "|" + px + "|" + py);
            return;
        }
        if ((DateTime.Now - lastClick).TotalMilliseconds <= SystemInformation.DoubleClickTime)
        {
            lastClick = DateTime.MinValue;
            Open();
        }
        else lastClick = DateTime.Now;
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        drawn = null;
        Redraw();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Stop();
        timer.Dispose();
        menu.Dispose();
        idle.Dispose();
        busy.Dispose();
        base.OnFormClosed(e);
    }
}

// The UI server is single-instance too, but that alone is not enough: the old
// launch path reused the server and still created a fresh ShellForm every time.
// This gate is scoped to the installation and UI port. A second launch signals
// the first window to restore/focus itself and exits before touching the server.
static class SingleInstance
{
    static Mutex mutex;
    static EventWaitHandle activateEvent;

    static string Token(string projectDir, int port)
    {
        string value = Path.GetFullPath(projectDir).TrimEnd('\\', '/').ToLowerInvariant() + "|" + port;
        ulong hash = 14695981039346656037UL;
        foreach (char c in value)
        {
            hash ^= c;
            hash *= 1099511628211UL;
        }
        return hash.ToString("x16");
    }

    public static bool TryAcquire(string projectDir, int port, out EventWaitHandle signal)
    {
        string token = Token(projectDir, port);
        mutex = new Mutex(false, @"Local\Skadi.Shell." + token);

        bool acquired = false;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }

        if (!acquired)
        {
            try
            {
                using (var existing = EventWaitHandle.OpenExisting(@"Local\Skadi.Activate." + token))
                    existing.Set();
            }
            catch (WaitHandleCannotBeOpenedException) { }
            signal = null;
            return false;
        }

        activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset,
            @"Local\Skadi.Activate." + token);
        signal = activateEvent;
        return true;
    }
}

// Closing the window stops the server. A job object is what makes that true
// even when the shell never gets to run its own shutdown: Windows kills every
// process in the job as soon as the last handle to it closes, which happens
// when this process exits for any reason at all -- a clean close, a crash, or
// Task Manager. Without it, a killed shell leaves the Node server running,
// later launches attach to that orphan instead of starting a fresh one, and
// the app ends up serving a window from code the server no longer has.
//
// Children inherit job membership, so llama-server goes with it.
static class ServerLife
{
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_TERMINATE = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong R, W, O, RT, WT, OT; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static IntPtr job = IntPtr.Zero;

    /// Create the job this process owns. Held open for the process lifetime;
    /// never closed explicitly, so the kill happens exactly when we go away.
    public static void Open()
    {
        if (job != IntPtr.Zero) return;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    CloseHandle(job);
                    job = IntPtr.Zero;
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        catch (Exception) { job = IntPtr.Zero; }
    }

    /// Tie a server we just started to this shell's lifetime.
    public static void Adopt(Process process)
    {
        if (job == IntPtr.Zero || process == null) return;
        try { AssignProcessToJobObject(job, process.Handle); }
        catch (Exception) { }
    }

    /// Tie a server that was already running to this shell's lifetime, so an
    /// orphan from an earlier run does not outlive this window either.
    public static void AdoptByPid(int pid)
    {
        if (job == IntPtr.Zero || pid <= 0) return;
        IntPtr handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (handle == IntPtr.Zero) return;
        try { AssignProcessToJobObject(job, handle); }
        catch (Exception) { }
        finally { CloseHandle(handle); }
    }
}

static class Shell
{
    const int DefaultPort = 7777;

    static string ExeDir()
    {
        return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, "Skadi", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static string FindEntry(string exeDir)
    {
        string[] candidates = {
            Path.Combine(exeDir, "skadi.mjs"),
            Path.Combine(exeDir, "..", "skadi.mjs"),
            Path.Combine(exeDir, "app", "skadi.mjs"),
        };
        foreach (string candidate in candidates)
        {
            string full = Path.GetFullPath(candidate);
            if (File.Exists(full)) return full;
        }
        return null;
    }

    static string FindOnPathOrIn(string fileName, string[] fallbacks)
    {
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(';'))
        {
            if (dir.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim('"'), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* malformed PATH entry */ }
        }
        foreach (string candidate in fallbacks)
        {
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;
        }
        return null;
    }

    static string FindNode()
    {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pfx = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return FindOnPathOrIn("node.exe", new string[] {
            Path.Combine(pf, @"nodejs\node.exe"),
            Path.Combine(pfx, @"nodejs\node.exe"),
            Path.Combine(local, @"Programs\nodejs\node.exe"),
        });
    }

    static string FindAppBrowser(string projectDir)
    {
        string configured = ReadSetting(projectDir, "uiBrowser");
        if (!string.IsNullOrEmpty(configured) && File.Exists(configured)) return configured;

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pfx = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = {
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pfx, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf, @"BraveSoftware\Brave-Browser\Application\brave.exe"),
            Path.Combine(pfx, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    static string ReadSetting(string projectDir, string key)
    {
        try
        {
            string file = Path.Combine(projectDir, @"config\settings.json");
            if (!File.Exists(file)) return null;
            Match m = Regex.Match(File.ReadAllText(file), "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
            if (m.Success) return m.Groups[1].Value.Replace("\\\\", "\\");
        }
        catch (Exception) { /* treat an unreadable settings file as unset */ }
        return null;
    }

    static int ReadPort(string projectDir)
    {
        try
        {
            string file = Path.Combine(projectDir, @"config\settings.json");
            if (!File.Exists(file)) return DefaultPort;
            Match m = Regex.Match(File.ReadAllText(file), "\"uiPort\"\\s*:\\s*(\\d+)");
            if (m.Success) return int.Parse(m.Groups[1].Value);
        }
        catch (Exception) { /* fall through to the default */ }
        return DefaultPort;
    }

    static bool IsServing(int port)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/state");
            request.Timeout = 1500;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch (Exception) { return false; }
    }

    static bool IsSameInstallation(int port, string projectDir)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/instance");
            request.Timeout = 1500;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                string root = reader.ReadToEnd().Trim();
                return string.Equals(Path.GetFullPath(root).TrimEnd('\\', '/'),
                    Path.GetFullPath(projectDir).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (Exception) { return false; }
    }

    /// The process id of the server already answering on this port, or 0.
    static int ServingPid(int port)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/instance/pid");
            request.Timeout = 1500;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                int pid;
                return int.TryParse(reader.ReadToEnd().Trim(), out pid) ? pid : 0;
            }
        }
        catch (Exception) { return 0; }
    }

    static bool WaitUntilServing(int port, string projectDir, Process child, int timeoutSeconds)
    {
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed.TotalSeconds < timeoutSeconds)
        {
            if (child != null && child.HasExited) return false;
            if (IsSameInstallation(port, projectDir)) return true;
            Thread.Sleep(250);
        }
        return false;
    }

    static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    /// Ask the server to shut itself down and wait for it to go. On the way
    /// out it stops the dev servers and apps started from Skadi -- programs a
    /// forced kill of its tree cannot reach once their launching shell has
    /// exited. Returns false if it could not be asked or did not exit in time.
    public static bool StopGracefully(int port, Process process, int timeoutMs)
    {
        if (process == null)
        {
            int pid = ServingPid(port);
            try { if (pid > 0) process = Process.GetProcessById(pid); } catch (Exception) { }
        }
        if (process == null || process.HasExited) return true;
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/shutdown");
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 2000;
            byte[] body = Encoding.UTF8.GetBytes("{}");
            request.ContentLength = body.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            using (request.GetResponse()) { }
        }
        catch (Exception) { return false; }
        try { return process.WaitForExit(timeoutMs); } catch (Exception) { return false; }
    }

    public static void KillTree(Process process)
    {
        if (process == null || process.HasExited) return;
        try
        {
            var killer = new ProcessStartInfo("taskkill.exe", "/PID " + process.Id + " /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(killer).WaitForExit(5000);
        }
        catch (Exception)
        {
            try { process.Kill(); } catch (Exception) { }
        }
    }

    static bool WebView2Available()
    {
        try
        {
            return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString(null));
        }
        catch (Exception) { return false; }
    }

    [STAThread]
    static int Main(string[] args)
    {
        try { Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
        catch (Exception) { /* pre-1703 Windows; the window still works */ }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string exeDir = ExeDir();
        string entry = FindEntry(exeDir);
        if (entry == null)
        {
            Fail("Could not find skadi.mjs next to:\n" + exeDir + "\n\nKeep Skadi.exe in the Skadi folder.");
            return 2;
        }

        string projectDir = Path.GetDirectoryName(entry);
        int port = ReadPort(projectDir);
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] != "--port") continue;
            if (!int.TryParse(args[i + 1], out port) || port < 1 || port > 65535)
            {
                Fail("Invalid --port. Use a number from 1 to 65535.");
                return 2;
            }
            break;
        }

        EventWaitHandle activateEvent;
        if (!SingleInstance.TryAcquire(projectDir, port, out activateEvent)) return 0;

        if (IsServing(port) && !IsSameInstallation(port, projectDir))
        {
            Fail("Port " + port + " is already serving another or older Skadi installation.\n\n" +
                 "Refusing to open it because its chats may belong to a different copy.\n" +
                 "This copy: " + projectDir + "\n\n" +
                 "Use a different uiPort in this copy's config\\settings.json, or launch with --port <number>.\n" +
                 "If this is an older server from this copy, close it and retry.");
            return 7;
        }

        Process child = null;
        bool weStartedIt = false;
        // Everything below joins this job, so the server stops when this
        // process does -- however it goes away.
        ServerLife.Open();

        if (!IsServing(port))
        {
            string node = FindNode();
            if (node == null)
            {
                Fail("node.exe was not found on PATH.\n\nInstall Node.js 20 or newer from https://nodejs.org and try again.");
                return 3;
            }

            string arguments = Quote(entry) + " --no-open";
            foreach (string arg in args) arguments += " " + Quote(arg);

            var info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = arguments,
                WorkingDirectory = projectDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            try { child = Process.Start(info); }
            catch (Exception ex)
            {
                Fail("Failed to start node:\n\n" + ex.Message);
                return 4;
            }
            ServerLife.Adopt(child);
            weStartedIt = true;

            // There is no console to print to, so keep a log to read when
            // something goes wrong.
            string logDir = Path.Combine(projectDir, "logs");
            Directory.CreateDirectory(logDir);
            var log = new StreamWriter(new FileStream(
                Path.Combine(logDir, "skadi.log"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite));
            log.AutoFlush = true;
            DataReceivedEventHandler write = delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) log.WriteLine(e.Data);
            };
            child.OutputDataReceived += write;
            child.ErrorDataReceived += write;
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            if (!WaitUntilServing(port, projectDir, child, 60))
            {
                KillTree(child);
                Fail("Skadi did not start within 60 seconds.\n\nSee logs\\skadi.log for details.");
                return 5;
            }
        }
        else
        {
            // A server for this installation is already up -- started by an
            // earlier shell that has since gone, or left behind by one that
            // was killed. Take it over rather than leaving it to outlive this
            // window too, so that closing the window really does stop it.
            ServerLife.AdoptByPid(ServingPid(port));
        }

        string url = "http://127.0.0.1:" + port + "/";

        if (WebView2Available())
        {
            try
            {
                string appName = "Skadi";
                Application.Run(new ShellForm(url, child, weStartedIt, appName, activateEvent));
                return 0;
            }
            catch (Exception ex)
            {
                Fail("The Skadi window failed to start:\n\n" + ex.Message +
                     "\n\nFalling back to a browser window.");
            }
        }

        // ---- fallback: a Chromium --app window ------------------------------
        string browser = FindAppBrowser(projectDir);
        if (browser == null)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception ex) { Fail("Could not open a browser:\n\n" + ex.Message); }
            return 0;
        }

        string profileDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"Skadi\browser-" + Path.GetFileNameWithoutExtension(browser).ToLowerInvariant());
        Directory.CreateDirectory(profileDir);
        try
        {
            string sentinel = Path.Combine(profileDir, "First Run");
            if (!File.Exists(sentinel)) File.WriteAllText(sentinel, "");
        }
        catch (Exception) { }

        string browserArgs =
            "--app=" + url + " --user-data-dir=" + Quote(profileDir) +
            " --window-size=1440,920 --no-first-run --no-default-browser-check --disable-sync" +
            " --disable-search-engine-choice-screen --disable-background-networking" +
            " --disable-features=msImplicitSignin,msEdgeIdentityFre,SigninPromo,ForYouFre";

        try
        {
            using (Process window = Process.Start(new ProcessStartInfo(browser, browserArgs) { UseShellExecute = false }))
            {
                window.WaitForExit();
            }
        }
        catch (Exception ex)
        {
            Fail("Could not open the Skadi window:\n\n" + ex.Message);
            if (weStartedIt) KillTree(child);
            return 6;
        }

        if (weStartedIt && !StopGracefully(port, child, 10000)) KillTree(child);
        return 0;
    }
}
