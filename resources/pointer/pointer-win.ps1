# Krypt Editor: where the pointer is and when a mouse button is pressed, while a
# screen recording runs. It is what lets a recording become a product demo
# (the picture zooms in on clicks). It reads the mouse only, never the keyboard,
# writes to its own output and nowhere else, and stops when Krypt Editor closes
# its end of the pipe.
#
# Output, one line per change:
#   ready            started
#   p <x> <y>        the pointer, in screen pixels
#   d <b> / u <b>    a button went down / up (0 = main, 1 = other)
#   r <x> <y> <w> <h> the recorded window's place on screen (when -Hwnd is given)
#   gone             that window closed
param([long]$Hwnd = 0)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class KryptPointer {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);

  public static void Run(long hwnd) {
    // Real pixels on every monitor, whatever its scaling (Windows 10 1607 and later; older ones just skip this).
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var o = new StreamWriter(Console.OpenStandardOutput());
    o.AutoFlush = true;
    var watch = new Thread(() => {
      try { var s = Console.OpenStandardInput(); var b = new byte[16]; while (s.Read(b, 0, b.Length) > 0) { } } catch { }
      Environment.Exit(0);
    });
    watch.IsBackground = true;
    watch.Start();

    // A left-handed mouse swaps the buttons; the main one is what counts as a click.
    bool swap = GetSystemMetrics(23) != 0;
    int main = swap ? 2 : 1, other = swap ? 1 : 2;
    var win = new IntPtr(hwnd);
    int lx = int.MinValue, ly = 0, n = 0;
    bool dm = false, dt = false, gone = false;
    RECT lr = new RECT();
    o.WriteLine("ready");
    while (true) {
      if (hwnd != 0 && !gone && n++ % 12 == 0) {
        if (!IsWindow(win)) { gone = true; o.WriteLine("gone"); }
        else {
          RECT r;
          // The frame as drawn (without the invisible resize border), which is what a window capture shows.
          if (DwmGetWindowAttribute(win, 9, out r, 16) != 0) GetWindowRect(win, out r);
          if (r.L != lr.L || r.T != lr.T || r.R != lr.R || r.B != lr.B) { lr = r; o.WriteLine("r " + r.L + " " + r.T + " " + (r.R - r.L) + " " + (r.B - r.T)); }
        }
      }
      POINT p;
      GetCursorPos(out p);
      bool m = (GetAsyncKeyState(main) & 0x8000) != 0;
      bool t = (GetAsyncKeyState(other) & 0x8000) != 0;
      if (p.X != lx || p.Y != ly || m != dm || t != dt) { lx = p.X; ly = p.Y; o.WriteLine("p " + p.X + " " + p.Y); }
      if (m != dm) { dm = m; o.WriteLine((m ? "d" : "u") + " 0"); }
      if (t != dt) { dt = t; o.WriteLine((t ? "d" : "u") + " 1"); }
      Thread.Sleep(15);
    }
  }
}
'@

[KryptPointer]::Run($Hwnd)
