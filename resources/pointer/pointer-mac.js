// Krypt Editor: mouse buttons and a window's place during a screen recording, on macOS.
//
// Run by Krypt Editor as: /usr/bin/osascript -l JavaScript pointer-mac.js <CGWindowID or 0>
// It only asks the system which mouse buttons are down and where one window
// is. It never reads the keyboard, sends no Apple events and needs no
// permission. Krypt Editor reads the pointer's position itself.
//
// Lines written (the same words as pointer-win.ps1):
//   ready            the mouse buttons can be read
//   d <b> / u <b>    button pressed / released (0 = left, 1 = right)
//   r <x> <y> <w> <h> the recorded window's place, in points from the main screen's top left
//   k                still here (also how a closed pipe is noticed)
//
// "pointer-mac.js test" runs for about a second on the first window on screen and exits: a self-check.

ObjC.import('AppKit');
ObjC.import('CoreGraphics');

var ON_SCREEN_ONLY = 1; // kCGWindowListOptionOnScreenOnly
var INCLUDING_WINDOW = 8; // kCGWindowListOptionIncludingWindow

function windows(option, id) {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(option, id)));
  return Array.isArray(list) ? list : [];
}

function rectOf(info) {
  var b = info && info.kCGWindowBounds;
  if (!b || !(b.Width > 0) || !(b.Height > 0)) return null;
  return [Math.round(b.X), Math.round(b.Y), Math.round(b.Width), Math.round(b.Height)].join(' ');
}

function parentGone() {
  try {
    ObjC.import('unistd');
    return $.getppid() === 1;
  } catch (e) {
    return false;
  }
}

function run(argv) {
  var test = argv[0] === 'test';
  var windowId = test ? 0 : parseInt(argv[0] || '0', 10) || 0;
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  var say = function (line) {
    out.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  };

  if (test) {
    var first = windows(ON_SCREEN_ONLY, 0)[0];
    windowId = first ? Number(first.kCGWindowNumber) || 0 : 0;
  }

  var down = Number($.NSEvent.pressedMouseButtons) || 0; // throws here, before "ready", if it cannot be read
  say('ready');

  var lastRect = '';
  for (var tick = 0; ; tick++) {
    var now = Number($.NSEvent.pressedMouseButtons) || 0;
    for (var b = 0; b < 2; b++) {
      var bit = 1 << b;
      if (now & bit && !(down & bit)) say('d ' + b);
      else if (!(now & bit) && down & bit) say('u ' + b);
    }
    down = now;

    // The window's place, twice a second (it can be moved while recording).
    if (windowId && tick % 33 === 0) {
      var rect = null;
      try {
        rect = rectOf(windows(INCLUDING_WINDOW, windowId)[0]);
      } catch (e) {
        rect = null;
      }
      if (rect && rect !== lastRect) {
        lastRect = rect;
        say('r ' + rect);
      }
    }

    if (tick % 133 === 132) {
      say('k');
      if (parentGone()) break;
    }
    if (test && tick >= 66) break;
    $.NSThread.sleepForTimeInterval(0.015);
  }
}
