# Desktop control helper for Skadi. One long-lived Windows PowerShell process:
# the C# below is compiled once, then each stdin line is a JSON request
# {id, op, ...} answered by one stdout line {id, ok, result | error}.
# Coordinates are always real screen pixels; desktop.mjs maps screenshot
# pixels to these.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SkadiInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);

  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, uint data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i); }
  static void Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i); }

  public static void Click(string button, int count) {
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int c = 0; c < count; c++) { Mouse(down, 0); Mouse(up, 0); System.Threading.Thread.Sleep(40); }
  }
  public static void Down(string button) { Mouse(button == "right" ? 0x0008u : 0x0002u, 0); }
  public static void Up(string button) { Mouse(button == "right" ? 0x0010u : 0x0004u, 0); }
  public static void Wheel(int clicks) { Mouse(0x0800, unchecked((uint)(clicks * 120))); }
  public static void Chord(int[] vks) {
    foreach (var vk in vks) { Key((ushort)vk, 0, IsExtended(vk) ? 1u : 0u); System.Threading.Thread.Sleep(15); }
    for (int k = vks.Length - 1; k >= 0; k--) Key((ushort)vks[k], 0, 2u | (IsExtended(vks[k]) ? 1u : 0u));
  }
  static bool IsExtended(int vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C; }
  public static void Type(string text) {
    foreach (char ch in text) {
      if (ch == '\n') { Key(0x0D, 0, 0); Key(0x0D, 0, 2); continue; }
      if (ch == '\r') continue;
      Key(0, ch, 4); Key(0, ch, 4 | 2);
      System.Threading.Thread.Sleep(4);
    }
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  // Chrome and Edge build a page's accessibility tree only once something
  // asks for it the way a screen reader does: an MSAA request to the page's
  // render window. Returns how many page windows were asked.
  public static int WakeBrowser(IntPtr top) {
    int n = 0; IntPtr child = IntPtr.Zero;
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    while ((child = FindWindowEx(top, child, "Chrome_RenderWidgetHostHWND", null)) != IntPtr.Zero) {
      object o; AccessibleObjectFromWindow(child, 0xFFFFFFFC, ref iid, out o); n++;
    }
    return n;
  }
  public static string ForegroundTitle() { var s = new System.Text.StringBuilder(512); GetWindowText(GetForegroundWindow(), s, 512); return s.ToString(); }
}
'@
[void][SkadiInput]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# The things a person can act on in the active window -- buttons, links,
# fields, tabs, list rows -- with their on-screen centres, read through UI
# Automation (the accessibility tree screen readers use). Works for native
# apps and for page content in Chrome and Edge.
# The main window whose title contains $title, or whose process is named $title.
function Find-Window([string]$title) {
  $needle = $title.ToLower()
  $hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle.ToLower().Contains($needle) -or $_.ProcessName.ToLower() -eq $needle) } | Select-Object -First 1
  if (-not $hit) { throw "No window matches '$title'" }
  return $hit
}

function Get-Elements([int]$max, [string]$query, [string]$title) {
  $A = [System.Windows.Automation.AutomationElement]
  $CT = [System.Windows.Automation.ControlType]
  $hwnd = [SkadiInput]::GetForegroundWindow()
  if ($title) {
    $hwnd = (Find-Window $title).MainWindowHandle
  }
  $root = $A::FromHandle($hwnd)
  $browser = [SkadiInput]::WakeBrowser($hwnd) -gt 0
  $types = @($CT::Button, $CT::Hyperlink, $CT::Edit, $CT::MenuItem, $CT::ListItem, $CT::TabItem, $CT::CheckBox,
    $CT::RadioButton, $CT::ComboBox, $CT::TreeItem, $CT::SplitButton, $CT::DataItem, $CT::MenuBar, $CT::Slider)
  $conds = [System.Windows.Automation.Condition[]]@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty), $_ })
  $either = New-Object System.Windows.Automation.OrCondition (, $conds)
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $either)
  # A browser that has just been asked for its page tree takes a moment to
  # build it: until then only the toolbar shows up.
  $linkType = New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty), $CT::Hyperlink
  for ($wait = 0; $browser -and $wait -lt 6 -and -not $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $linkType); $wait++) {
    Start-Sleep -Milliseconds 400
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $either)
  }
  $needle = if ($query) { $query.ToLower() } else { '' }
  $out = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($e in $found) {
    try { $c = $e.Current } catch { continue }
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 3 -or $r.Height -lt 3) { continue }
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $name = [string]$c.Name
    if (-not $name) { $name = [string]$c.HelpText }
    if (-not $name -and $type -ne 'Edit' -and $type -ne 'ComboBox') { continue }
    if ($needle -and -not $name.ToLower().Contains($needle)) { continue }
    if ($name.Length -gt 90) { $name = $name.Substring(0, 90) + '...' }
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    # Web pages often nest a link inside a link with the same name; list it once.
    $key = "$type|$name|$([int]($x / 40))|$([int]($y / 40))"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    [void]$out.Add(@{ name = $name; type = $type; x = $x; y = $y })
    if ($out.Count -ge $max) { break }
  }
  return @{ window = $root.Current.Name; elements = @($out) }
}

function Invoke-Op($r) {
  switch ($r.op) {
    'ping' { return @{ pong = $true } }
    'screenshot' {
      # One monitor at a time: a multi-monitor desktop squeezed into one image
      # is too small to read. -1 means every monitor at once.
      $screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { -not $_.Primary })
      $idx = [int]$r.monitor
      if ($idx -lt 0) { $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen }
      elseif ($idx -ge $screens.Count) { throw "There are $($screens.Count) monitor(s), numbered 0-$($screens.Count - 1)." }
      else { $vs = $screens[$idx].Bounds }
      $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
      $g.Dispose()
      $scale = [Math]::Min(1.0, [double]$r.maxWidth / $vs.Width)
      $w = [int][Math]::Round($vs.Width * $scale); $h = [int][Math]::Round($vs.Height * $scale)
      $out = New-Object System.Drawing.Bitmap $w, $h
      $g2 = [System.Drawing.Graphics]::FromImage($out)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $w, $h)
      # Mark the cursor so the model can see where the pointer is.
      $p = [System.Windows.Forms.Cursor]::Position
      $cx = ($p.X - $vs.Left) * $scale; $cy = ($p.Y - $vs.Top) * $scale
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
      $g2.DrawEllipse($pen, [float]($cx - 6), [float]($cy - 6), 12, 12)
      $g2.Dispose(); $bmp.Dispose()
      $out.Save($r.path, [System.Drawing.Imaging.ImageFormat]::Png)
      $out.Dispose()
      return @{ path = $r.path; width = $w; height = $h; scale = $scale; left = $vs.Left; top = $vs.Top; screenWidth = $vs.Width; screenHeight = $vs.Height; monitors = $screens.Count; monitor = $idx; foreground = [SkadiInput]::ForegroundTitle() }
    }
    'elements' { return Get-Elements ([int]$r.max) ([string]$r.query) ([string]$r.title) }
    'move' { [void][SkadiInput]::SetCursorPos($r.x, $r.y); return @{} }
    'click' {
      [void][SkadiInput]::SetCursorPos($r.x, $r.y); Start-Sleep -Milliseconds 30
      [SkadiInput]::Click([string]$r.button, [int]$r.count); return @{}
    }
    'drag' {
      [void][SkadiInput]::SetCursorPos($r.x, $r.y); Start-Sleep -Milliseconds 30
      [SkadiInput]::Down('left')
      for ($s = 1; $s -le 10; $s++) {
        [void][SkadiInput]::SetCursorPos([int]($r.x + ($r.x2 - $r.x) * $s / 10), [int]($r.y + ($r.y2 - $r.y) * $s / 10))
        Start-Sleep -Milliseconds 20
      }
      [SkadiInput]::Up('left'); return @{}
    }
    'scroll' {
      if ($null -ne $r.x) { [void][SkadiInput]::SetCursorPos($r.x, $r.y) }
      [SkadiInput]::Wheel([int]$r.clicks); return @{}
    }
    'type' { [SkadiInput]::Type([string]$r.text); return @{} }
    'keys' { [SkadiInput]::Chord([int[]]$r.vks); return @{} }
    'windows' {
      $list = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
        ForEach-Object { @{ title = $_.MainWindowTitle; process = $_.ProcessName; pid = $_.Id } }
      return @{ windows = @($list); foreground = [SkadiInput]::ForegroundTitle() }
    }
    'focus' {
      $hit = Find-Window ([string]$r.title)
      $h = $hit.MainWindowHandle
      if ([SkadiInput]::IsIconic($h)) { [void][SkadiInput]::ShowWindow($h, 9) }
      # Windows only lets a process take the foreground right after input; a
      # stray Alt press satisfies that rule.
      [SkadiInput]::Chord(@(0x12))
      [void][SkadiInput]::SetForegroundWindow($h)
      return @{ title = $hit.MainWindowTitle; process = $hit.ProcessName }
    }
    'open' {
      if ($r.args) { Start-Process -FilePath $r.target -ArgumentList $r.args } else { Start-Process -FilePath $r.target }
      return @{}
    }
    default { throw "unknown op $($r.op)" }
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $r = $null
  try {
    $r = $line | ConvertFrom-Json
    $result = Invoke-Op $r
    $reply = @{ id = $r.id; ok = $true; result = $result }
  } catch {
    $reply = @{ id = $(if ($r) { $r.id } else { $null }); ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
