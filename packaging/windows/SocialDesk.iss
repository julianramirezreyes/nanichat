; Social Desk — Windows installer (Inno Setup 6, per-user, no administrator rights).
;
; Compile (the CI workflow does this after build-payload.mjs):
;   ISCC.exe /DAppVersion=0.1.0 /DPayloadDir=C:\path\dist\payload /DOutputDir=C:\path\dist\installer SocialDesk.iss
;
; Data policy: the application lives in {app} (%LOCALAPPDATA%\Programs\SocialDesk). User data lives OUTSIDE it, in
; %LOCALAPPDATA%\SocialDesk\data (database + vault.key) and \logs. Uninstall NEVER deletes them (also in silent mode);
; upgrades install over the same AppId and keep them. Saved as UTF-8 with BOM for the Spanish texts.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef PayloadDir
  #define PayloadDir AddBackslash(SourcePath) + "..\..\dist\payload"
#endif
#ifndef OutputDir
  #define OutputDir AddBackslash(SourcePath) + "..\..\dist\installer"
#endif

#define AppName "Social Desk"
#define PowerShellExe "{sys}\WindowsPowerShell\v1.0\powershell.exe"
#define PsArgs "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File"
#define IconFile "{app}\launcher\social-desk.ico"

[Setup]
; Fixed AppId: never change it, or upgrades will install side by side instead of in place.
AppId={{6F1E2D3C-4B5A-4E69-8D7C-1A2B3C4D5E6F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Social Desk
AppPublisherURL=https://github.com/julianramirezreyes/social-automation
AppSupportURL=https://github.com/julianramirezreyes/social-automation/issues
AppUpdatesURL=https://github.com/julianramirezreyes/social-automation/releases
DefaultDirName={localappdata}\Programs\SocialDesk
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=SocialDesk-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
ShowLanguageDialog=no
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={#IconFile}
#if FileExists(AddBackslash(PayloadDir) + "launcher\social-desk.ico")
SetupIconFile={#AddBackslash(PayloadDir)}launcher\social-desk.ico
#endif

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Clean upgrade: remove the previous version's program folders (never the user data, which is not under {app}).
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\launcher"
Type: filesandordirs; Name: "{app}\docs"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Social Desk"; Filename: "{#PowerShellExe}"; Parameters: "{#PsArgs} ""{app}\launcher\launch.ps1"""; WorkingDir: "{app}"; IconFilename: "{#IconFile}"; Comment: "Abre Social Desk en el navegador"
Name: "{group}\Detener Social Desk"; Filename: "{#PowerShellExe}"; Parameters: "{#PsArgs} ""{app}\launcher\stop.ps1"""; WorkingDir: "{app}"; IconFilename: "{#IconFile}"; Comment: "Cierra Social Desk"
Name: "{group}\Manual de usuario"; Filename: "{app}\docs\Manual-Social-Desk.pdf"; Comment: "Manual de usuario de Social Desk (PDF)"
Name: "{autodesktop}\Social Desk"; Filename: "{#PowerShellExe}"; Parameters: "{#PsArgs} ""{app}\launcher\launch.ps1"""; WorkingDir: "{app}"; IconFilename: "{#IconFile}"; Comment: "Abre Social Desk en el navegador"; Tasks: desktopicon

[Run]
Filename: "{#PowerShellExe}"; Parameters: "{#PsArgs} ""{app}\launcher\launch.ps1"""; WorkingDir: "{app}"; Description: "Abrir Social Desk al terminar"; Flags: postinstall nowait skipifsilent runhidden

[UninstallRun]
; Stop the server before its files are removed. Runs in silent uninstalls too.
Filename: "{#PowerShellExe}"; Parameters: "{#PsArgs} ""{app}\launcher\stop.ps1"" -Quiet"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopSocialDesk"

[UninstallDelete]
; Files created at run time inside the program folders (for example app\.next\cache). Only these subfolders of
; {app} are removed, never the user data folder %LOCALAPPDATA%\SocialDesk\data.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\launcher"
Type: filesandordirs; Name: "{app}\docs"
Type: dirifempty; Name: "{app}"
Type: files; Name: "{localappdata}\SocialDesk\run\pid.txt"
Type: files; Name: "{localappdata}\SocialDesk\run\port.txt"
Type: dirifempty; Name: "{localappdata}\SocialDesk\run"

[Code]
function StopRunningInstance(): Boolean;
var
  StopScript: String;
  ResultCode: Integer;
begin
  Result := True;
  StopScript := ExpandConstant('{app}\launcher\stop.ps1');
  if not FileExists(StopScript) then
    Exit;
  Log('Stopping a running Social Desk before copying files: ' + StopScript);
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + StopScript + '" -Quiet',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('stop.ps1 exit code: ' + IntToStr(ResultCode))
  else
    Log('stop.ps1 could not be started: ' + SysErrorMessage(ResultCode));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  // Upgrade in place: the previous version may be running from {app}; stop it so its files can be replaced.
  StopRunningInstance();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent()) then
    MsgBox('Social Desk se desinstaló.' + #13#10#13#10 +
      'Tus datos (base de datos, credenciales cifradas y su llave vault.key) se conservaron en:' + #13#10 +
      ExpandConstant('{localappdata}\SocialDesk\data') + #13#10#13#10 +
      'Si vuelves a instalar Social Desk, los encontrará ahí. Si quieres borrarlos para siempre, borra esa carpeta a mano ' +
      '(no se puede deshacer).', mbInformation, MB_OK);
end;
