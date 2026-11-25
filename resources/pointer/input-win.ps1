# Krypt Editor: clicks and typing in ONE window, for a recording an AI agent was
# allowed to make of that window. It runs only after the person said yes in
# Krypt Editor's own prompt, only for that window, and only while Krypt Editor
# keeps its end of the pipe open.
#
# It lets go at once when:
#   - the mouse is moved by someone else (that is how a person takes over),
#   - another app's window is under the pointer or in front,
#   - the window closes.
#
# Commands on stdin, one per line (x, y are 0..1 across and down the window as drawn):
#   focus | move <x> <y> | click <x> <y> | type <base64 utf-8> | key <virtual key> | wheel <notches> | wait <ms>
# Each is answered with "ok" or "err <why>"; after an error it exits.
# -DryRun answers what it would do ("dry ...") and touches nothing.
param([long]$Hwnd = 0, [switch]$DryRun)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KryptInput {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  // A keyboard INPUT, laid out for 64-bit and for 32-bit Windows.
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT64 { [FieldOffset(0)] public int type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan; [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 28)] struct INPUT32 { [FieldOffset(0)] public int type; [FieldOffset(4)] public ushort vk; [FieldOffset(6)] public ushort scan; [FieldOffset(8)] public uint flags; [FieldOffset(12)] public uint time; [FieldOffset(16)] public IntPtr extra; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint = "SendInput")] static extern uint SendInput64(uint n, INPUT64[] inputs, int size);
  [DllImport("user32.dll", EntryPoint = "SendInput")] static extern uint SendInput32(uint n, INPUT32[] inputs, int size);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);

  static IntPtr win;
  static uint pid;
  static bool dry;
  static StreamWriter o;
  // Where this helper last put the pointer. Anywhere else means a person moved it.
  static bool placed;
  static int ex, ey;

  class Stop : Exception { public Stop(string why) : base(why) { } }

  static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

  static RECT Frame() {
    if (!IsWindow(win)) throw new Stop("the window was closed");
    RECT r;
    // The frame as drawn, which is what a window capture shows.
    if (DwmGetWindowAttribute(win, 9, out r, 16) != 0) GetWindowRect(win, out r);
    if (r.R - r.L < 8 || r.B - r.T < 8) throw new Stop("the window has no size (is it minimized?)");
    return r;
  }

  static void Mine() {
    if (dry) return;
    if (!placed) return;
    POINT p; GetCursorPos(out p);
    if (Math.Abs(p.X - ex) > 8 || Math.Abs(p.Y - ey) > 8) throw new Stop("the mouse was moved by hand, so Krypt Editor let go of it");
  }

  static void Front() {
    if (dry) return;
    if (PidOf(GetForegroundWindow()) != pid) throw new Stop("another app came to the front");
  }

  static void Focus() {
    if (dry) { o.WriteLine("dry focus"); return; }
    if (IsIconic(win)) { ShowWindow(win, 9); Thread.Sleep(300); }
    if (PidOf(GetForegroundWindow()) != pid) {
      uint other; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out other);
      uint me = GetCurrentThreadId();
      AttachThreadInput(me, fg, true);
      SetForegroundWindow(win); BringWindowToTop(win);
      AttachThreadInput(me, fg, false);
      Thread.Sleep(300);
    }
    if (PidOf(GetForegroundWindow()) != pid) throw new Stop("the window could not be brought to the front");
  }

  static void Glide(double nx, double ny) {
    RECT r = Frame();
    int tx = r.L + (int)Math.Round(Math.Min(0.995, Math.Max(0.005, nx)) * (r.R - r.L));
    int ty = r.T + (int)Math.Round(Math.Min(0.995, Math.Max(0.005, ny)) * (r.B - r.T));
    if (dry) { o.WriteLine("dry pointer to " + tx + " " + ty + " in " + r.L + " " + r.T + " " + (r.R - r.L) + " " + (r.B - r.T)); return; }
    Mine();
    POINT p; GetCursorPos(out p);
    double dist = Math.Sqrt((double)(tx - p.X) * (tx - p.X) + (double)(ty - p.Y) * (ty - p.Y));
    int ms = (int)Math.Min(900, Math.Max(280, 220 + dist * 0.5));
    int steps = Math.Max(1, ms / 15);
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      double e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
      int x = p.X + (int)Math.Round((tx - p.X) * e), y = p.Y + (int)Math.Round((ty - p.Y) * e);
      if (i > 1) Mine();
      SetCursorPos(x, y); placed = true; ex = x; ey = y;
      Thread.Sleep(15);
    }
  }

  static void Click(double nx, double ny) {
    Glide(nx, ny);
    if (dry) { o.WriteLine("dry click"); return; }
    Thread.Sleep(140);
    Mine(); Front();
    POINT p; GetCursorPos(out p);
    if (PidOf(WindowFromPoint(p)) != pid) throw new Stop("another app's window is under the pointer there");
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(70);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(350);
  }

  static void Unicode(char c, bool up) {
    uint flags = 0x0004u | (up ? 0x0002u : 0u);
    if (IntPtr.Size == 8) { var a = new INPUT64[1]; a[0].type = 1; a[0].scan = c; a[0].flags = flags; SendInput64(1, a, 40); }
    else { var a = new INPUT32[1]; a[0].type = 1; a[0].scan = c; a[0].flags = flags; SendInput32(1, a, 28); }
  }

  static void Type(string text) {
    if (dry) { o.WriteLine("dry type " + text.Length + " characters"); return; }
    var rnd = new Random();
    int n = 0;
    foreach (char c in text) {
      // Before every character: a window that takes the keyboard mid-word gets none of it.
      Mine(); Front(); n++;
      if (c == '\n') { keybd_event(0x0D, 0, 0, UIntPtr.Zero); keybd_event(0x0D, 0, 2, UIntPtr.Zero); }
      else if (c != '\r') { Unicode(c, false); Unicode(c, true); }
      Thread.Sleep(45 + rnd.Next(50));
    }
    Thread.Sleep(250);
  }

  static void Key(int vk) {
    if (vk < 8 || vk > 0x7B) throw new Stop("that key is not allowed");
    if (dry) { o.WriteLine("dry key " + vk); return; }
    Mine(); Front();
    keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
    Thread.Sleep(40);
    keybd_event((byte)vk, 0, 2, UIntPtr.Zero);
    Thread.Sleep(350);
  }

  static void Wheel(int notches) {
    if (dry) { o.WriteLine("dry wheel " + notches); return; }
    RECT r = Frame();
    POINT p; GetCursorPos(out p);
    if (p.X < r.L || p.X >= r.R || p.Y < r.T || p.Y >= r.B) Glide(0.5, 0.55);
    Mine(); Front();
    GetCursorPos(out p);
    if (PidOf(WindowFromPoint(p)) != pid) throw new Stop("another app's window is under the pointer there");
    int left = Math.Abs(notches), dir = notches > 0 ? -1 : 1;
    while (left-- > 0) { Mine(); mouse_event(0x0800, 0, 0, dir * 120, UIntPtr.Zero); Thread.Sleep(60); }
    Thread.Sleep(350);
  }

  public static void Run(long hwnd, bool dryRun) {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
    o = new StreamWriter(Console.OpenStandardOutput());
    o.AutoFlush = true;
    win = new IntPtr(hwnd);
    dry = dryRun;
    if (hwnd == 0 || !IsWindow(win)) { o.WriteLine("err the window is not open"); return; }
    pid = PidOf(win);
    o.WriteLine("ready");
    var inv = CultureInfo.InvariantCulture;
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var a = line.Trim().Split(' ');
      try {
        switch (a[0]) {
          case "focus": Focus(); break;
          case "move": Glide(double.Parse(a[1], inv), double.Parse(a[2], inv)); break;
          case "click": Click(double.Parse(a[1], inv), double.Parse(a[2], inv)); break;
          case "type": Type(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); break;
          case "key": Key(int.Parse(a[1], inv)); break;
          case "wheel": Wheel(int.Parse(a[1], inv)); break;
          case "wait": { int ms = Math.Min(20000, Math.Max(0, int.Parse(a[1], inv))); for (int t = 0; t < ms; t += 50) { Thread.Sleep(50); Mine(); } break; }
          case "": continue;
          default: throw new Stop("unknown command");
        }
        o.WriteLine("ok");
      } catch (Stop s) { o.WriteLine("err " + s.Message); return; }
      catch (Exception e) { o.WriteLine("err " + e.GetType().Name); return; }
    }
  }
}
'@

[KryptInput]::Run($Hwnd, $DryRun.IsPresent)
