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
// working. Dragging is a real WM_NCLBUTTONDOWN, not a mouse-move loop, so snap
// layouts behave exactly as they do for any other window.
//
// If WebView2 is unavailable the shell falls back to a Chromium --app window,
// which loses the integrated title bar but still runs.

using System;
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

    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

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

    public ShellForm(string url, Process server, bool ownsServer, string appName)
    {
        this.url = url;
        this.server = server;
        this.ownsServer = ownsServer;

        Text = appName;
        // Sizable, not None: we want the native resize borders and the shadow.
        // The caption is removed in WndProc instead.
        FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1440, 920);
        MinimumSize = new Size(900, 560);
        BackColor = Color.FromArgb(7, 10, 14); // matches the UI's --bg
        DoubleBuffered = true;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName);
        }
        catch (Exception) { /* the window just uses the default icon */ }

        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.FromArgb(7, 10, 14);
        Controls.Add(view);

        Load += async (s, e) => await Start();
        FormClosed += (s, e) => { if (ownsServer) Shell.KillTree(server); };
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

        // The page names itself (document.title); the taskbar follows.
        core.DocumentTitleChanged += (s, e) =>
        {
            string title = core.DocumentTitle;
            if (!string.IsNullOrEmpty(title)) Text = title;
        };

        // Window commands arrive from the page's own title bar.
        core.WebMessageReceived += (s, e) =>
        {
            string body;
            try { body = e.TryGetWebMessageAsString(); }
            catch (Exception) { return; }
            OnWindowCommand(body);
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
            "window.skadiWindow = {" +
            "  minimize: () => window.chrome.webview.postMessage('minimize')," +
            "  toggleMaximize: () => window.chrome.webview.postMessage('maximize')," +
            "  close: () => window.chrome.webview.postMessage('close')," +
            "  drag: () => window.chrome.webview.postMessage('drag')" +
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
        }
    }

    void SyncMaximizeState()
    {
        // A maximised window with WS_THICKFRAME hangs its borders off the edge
        // of the monitor; padding pulls the content back into view.
        Padding = WindowState == FormWindowState.Maximized
            ? new Padding(8, 8, 8, 8) : new Padding(0);

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
                Application.Run(new ShellForm(url, child, weStartedIt, appName));
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

        if (weStartedIt) KillTree(child);
        return 0;
    }
}
