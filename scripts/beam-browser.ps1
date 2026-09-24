param(
  [ValidateSet('inspect','capture','click','keys','invoke','key-rows','copy-row-key','save-key')][string]$Action = 'inspect',
  [int]$X = 0, [int]$Y = 0, [string]$Keys = '', [string]$OutputPath = '', [string]$Name = '', [string]$TabMatch = 'Beam'
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BeamWindow {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
}
'@
$beamProc = Get-Process chrome -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (!$beamProc) { throw 'Beam browser window not found' }
[BeamWindow]::ShowWindow($beamProc.MainWindowHandle,9) | Out-Null
[BeamWindow]::SetForegroundWindow($beamProc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
$browserRoot = [System.Windows.Automation.AutomationElement]::FromHandle($beamProc.MainWindowHandle)
$tabs = $browserRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem))
$beamTab = $tabs | Where-Object { $_.Current.Name -match $TabMatch } | Select-Object -Last 1
if(!$beamTab) { throw 'Beam tab not found; no other tab will be changed' }
($beamTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
Start-Sleep -Milliseconds 250
switch($Action) {
 'key-rows' {
  $elements = $browserRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($element in $elements) {
   if($element.Current.Name -match '^[0-9a-f]{8}-[0-9a-f-]{27}$') { [pscustomobject]@{Id=$element.Current.Name;Bounds=$element.Current.BoundingRectangle.ToString()} }
  }
 }
 'copy-row-key' {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
  $buttons = $browserRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  $copy = $buttons | Where-Object { [Math]::Abs($_.Current.BoundingRectangle.Y - $Y) -lt 3 -and [Math]::Abs($_.Current.BoundingRectangle.X - $X) -lt 3 } | Select-Object -First 1
  if(!$copy) { throw 'Observed copy button not found' }
  ($copy.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
 }
 'inspect' {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($beamProc.MainWindowHandle)
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($element in $elements) {
   $type = $element.Current.ControlType.ProgrammaticName
   if($type -match 'Button|Hyperlink|MenuItem|Edit|CheckBox') {
    [pscustomobject]@{Type=$type;Name=$element.Current.Name;Bounds=$element.Current.BoundingRectangle.ToString()}
   }
  }
 }
 'capture' {
  if(!$OutputPath) { $OutputPath = Join-Path $PSScriptRoot '../artifacts/beam-screen.png' }
  $rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap($rect.Width,$rect.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Location,[System.Drawing.Point]::Empty,$rect.Size)
  $bitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  Write-Output $OutputPath
 }
 'click' {
  [BeamWindow]::SetCursorPos($X,$Y) | Out-Null
  [BeamWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [BeamWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 }
 'keys' { [System.Windows.Forms.SendKeys]::SendWait($Keys) }
 'invoke' {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($beamProc.MainWindowHandle)
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Name)
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if(!$element) { throw "Control not found: $Name" }
  $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
 }
 'save-key' {
  $value = [System.Windows.Forms.Clipboard]::GetText().Trim()
  if($value.Length -lt 30 -or $value -match '\s') { throw 'Clipboard does not contain a single API key' }
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '../.beam-token'),$value)
  [System.Windows.Forms.Clipboard]::Clear()
  Write-Output 'Beam key saved locally; clipboard cleared. Value not displayed.'
 }
}
