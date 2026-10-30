export const windowsInventory = String.raw`$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
if (-not ('DshVisibleWindows' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshVisibleWindows {
    public class Row {
        public int pid;
        public string windowId, title, className;
        public bool visible, cloaked, toolWindow, noActivate, minimized, foreground;
        public int x, y, inputX, inputY, width, height, zOrder;
    }
    private delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetLong64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetLong32(IntPtr hwnd, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);
    public static Row[] List() {
        var rows = new List<Row>(); var foreground = GetForegroundWindow(); int order = 0;
        EnumProc callback = delegate(IntPtr hwnd, IntPtr unused) {
            int z = order++;
            if (!IsWindowVisible(hwnd)) return true;
            var title = new StringBuilder(2048); GetWindowText(hwnd, title, title.Capacity);
            if (title.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity);
            int cloak = 0; DwmGetWindowAttribute(hwnd, 14, out cloak, 4);
            Rect legacy, box; GetWindowRect(hwnd, out legacy);
            if (DwmGetWindowAttribute(hwnd, 9, out box, Marshal.SizeOf(typeof(Rect))) != 0) box = legacy;
            long styles = IntPtr.Size == 8 ? GetLong64(hwnd, -20).ToInt64() : GetLong32(hwnd, -20);
            rows.Add(new Row { pid=(int)pid, windowId=hwnd.ToInt64().ToString(), title=title.ToString(), className=name.ToString(),
                visible=true, cloaked=cloak!=0, toolWindow=(styles & 0x80)!=0, noActivate=(styles & 0x08000000)!=0,
                minimized=IsIconic(hwnd) || legacy.left<=-30000 || legacy.top<=-30000,
                foreground=hwnd==foreground, x=box.left, y=box.top, inputX=legacy.left, inputY=legacy.top,
                width=box.right-box.left, height=box.bottom-box.top, zOrder=z });
            return true;
        };
        EnumWindows(callback, IntPtr.Zero); return rows.ToArray();
    }
}
'@ }
if (-not ('DshVisibleWindows' -as [type])) { throw 'Windows window inventory could not initialize' }
$processes=@{}
@(foreach ($window in [DshVisibleWindows]::List()) {
    if (-not $processes.ContainsKey($window.pid)) {
        $p=Get-Process -Id $window.pid
        if (-not $p) { continue }
        $info=$p.MainModule.FileVersionInfo
        $processes[$window.pid]=[pscustomobject]@{ Id=$p.Id; ProcessName=$p.ProcessName; Path=$p.Path;
            Started=$p.StartTime.ToUniversalTime().Ticks.ToString(); Product=$info.ProductName; DisplayName=$info.FileDescription }
    }
    $p=$processes[$window.pid]
    if (-not $p) { continue }
    [pscustomobject]@{
        pid=$p.Id; windowId=$window.windowId; name=$p.ProcessName; title=$window.title;
        path=$p.Path; started=$p.Started; product=$p.Product; displayName=$p.DisplayName;
        visible=$window.visible; cloaked=$window.cloaked; toolWindow=$window.toolWindow; noActivate=$window.noActivate;
        className=$window.className; x=$window.x; y=$window.y; inputX=$window.inputX; inputY=$window.inputY; width=$window.width; height=$window.height;
        minimized=$window.minimized; foreground=$window.foreground; zOrder=$window.zOrder
    }
}) | ConvertTo-Json -Compress`;

const shellProcesses = /^(?:shellexperiencehost|startmenuexperiencehost|searchhost|searchapp|textinputhost|widgets|widgetservice|widgetboard|lockapp)$/i;
const shellClasses = /^(?:Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd|tooltips_class32|MSCTFIME UI|IME)$/i;

export function usefulWindows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^-?\d+$/.test(String(row.windowId || "")) || String(row.windowId) === "0"
      || !row.started || typeof row.title !== "string" || !row.title.trim() || !/\.exe$/i.test(row.path || "")
      || row.visible !== true || row.cloaked || row.toolWindow || row.noActivate
      || shellProcesses.test(row.name || "") || shellClasses.test(row.className || "")) return false;
    if (!row.minimized && (!(row.width >= 64) || !(row.height >= 32))) return false;
    const identity = `${row.pid}:${row.windowId}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  }).sort((a, b) => Number(b.foreground) - Number(a.foreground) || (a.zOrder ?? 100000) - (b.zOrder ?? 100000));
}
