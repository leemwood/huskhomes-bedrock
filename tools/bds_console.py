"""Submit commands to an existing visible Windows BDS terminal."""
import ctypes as c
import ctypes.wintypes as w


class Character(c.Union):
    _fields_ = [('UnicodeChar', w.WCHAR), ('AsciiChar', c.c_char)]


class KeyEvent(c.Structure):
    _fields_ = [('bKeyDown', w.BOOL), ('wRepeatCount', w.WORD), ('wVirtualKeyCode', w.WORD),
                ('wVirtualScanCode', w.WORD), ('uChar', Character), ('dwControlKeyState', w.DWORD)]


class Event(c.Union):
    _fields_ = [('KeyEvent', KeyEvent), ('padding', c.c_byte * 16)]


class Input(c.Structure):
    _fields_ = [('EventType', w.WORD), ('Event', Event)]


def send_commands(pid, commands):
    kernel = c.WinDLL('kernel32', use_last_error=True)
    user = c.WinDLL('user32', use_last_error=True)
    kernel.AttachConsole.argtypes = [w.DWORD]
    kernel.AttachConsole.restype = w.BOOL
    kernel.GetConsoleWindow.restype = w.HWND
    user.IsWindowVisible.argtypes = [w.HWND]
    user.IsWindowVisible.restype = w.BOOL
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.WriteConsoleInputW.argtypes = [w.HANDLE, c.POINTER(Input), w.DWORD, c.POINTER(w.DWORD)]
    kernel.WriteConsoleInputW.restype = w.BOOL
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        raise c.WinError(c.get_last_error())
    kernel.SetConsoleCtrlHandler(None, True)
    handle = None
    try:
        visible = bool(user.IsWindowVisible(kernel.GetConsoleWindow()))
        if not visible:
            raise RuntimeError('Expected the existing BDS terminal to be visible')
        handle = kernel.CreateFileW('CONIN$', 0xC0000000, 3, None, 3, 0, None)
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        for command in commands:
            if '\r' in command or '\n' in command:
                raise ValueError('Console commands must be a single line')
            records = []
            for char in command + '\r':
                for down in [True, False]:
                    event = Input(); event.EventType = 1
                    event.Event.KeyEvent.bKeyDown = down
                    event.Event.KeyEvent.wRepeatCount = 1
                    event.Event.KeyEvent.wVirtualKeyCode = 13 if char == '\r' else 0
                    event.Event.KeyEvent.uChar.UnicodeChar = char
                    records.append(event)
            array = (Input * len(records))(*records); written = w.DWORD()
            if not kernel.WriteConsoleInputW(handle, array, len(array), c.byref(written)):
                raise c.WinError(c.get_last_error())
            if written.value != len(records):
                raise RuntimeError('Only part of a console command was submitted')
    finally:
        if handle and handle != c.c_void_p(-1).value:
            kernel.CloseHandle(handle)
        kernel.FreeConsole()
