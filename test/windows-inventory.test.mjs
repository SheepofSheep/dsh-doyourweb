import { test } from "node:test";
import assert from "node:assert/strict";
import { PowerShellWorker } from "../src/apps/powershell.js";
import { usefulWindows, windowsInventory } from "../src/apps/windows.js";

test("Windows inventory preserves readable apps beside inaccessible processes", { skip: process.platform !== "win32" }, async () => {
  const worker = new PowerShellWorker();
  try {
    // Exercise the actual PowerShell inventory/JSON boundary. Some elevated
    // processes expose a window but return null Path and StartTime to Get-Process.
    const fixture = `function Get-Process { param($Id)
      if ($Id -eq 1) { return [pscustomobject]@{Id=1;ProcessName='Protected';Path=$null;StartTime=$null} }
      [pscustomobject]@{Id=2;ProcessName='Readable';Path='C:\\Readable.exe';StartTime=[datetime]'2026-01-01';MainModule=$null}
    }
    $windows=@(1,2 | ForEach-Object { [pscustomobject]@{pid=$_;windowId="$($_)";title='Window';visible=$true;width=800;height=600} })
    `;
    const { stdout } = await worker.run(fixture + windowsInventory.replace("[DshVisibleWindows]::List()", "$windows"));
    const apps = usefulWindows([JSON.parse(stdout)].flat());
    assert.deepEqual(apps.map(app => app.name), ["Readable"]);
    assert.equal(apps[0].pid, 2);
    assert.ok(apps[0].started);
  } finally { worker.close(); }
});

test("Windows helper and inventory accept an empty window list", { skip: process.platform !== "win32" }, async () => {
  const worker = new PowerShellWorker();
  try {
    assert.equal((await worker.run("$null")).stdout, "");
    assert.equal((await worker.run(windowsInventory.replace("[DshVisibleWindows]::List()", "@()"))).stdout, "");
  } finally { worker.close(); }
});
