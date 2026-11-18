; TeamClaude.exe, built twice from this file.
;
; The installed build is the program the Start Menu, the sign-in Run entry
; and the installer's Finish page start. It shows no window of its own: it
; runs `teamclaude desktop` (start the proxy unless it is running, then open
; the dashboard) on the Node and app folders beside it, with the console
; hidden. `--stop` ends the proxy instead. Any other parameters, such as
; --no-open, go to `desktop`.
;
; The portable build (-DPORTABLE) is the same program as one file with
; nothing else installed. It carries the Node and app folders inside itself
; and unpacks them once to %LOCALAPPDATA%\TeamClaude\portable\<version>, then
; runs from there. It unpacks to a persistent folder, not NSIS's $PLUGINSDIR,
; because the proxy `desktop` starts is detached and keeps running from those
; files after this program exits, and $PLUGINSDIR is deleted on exit. The
; folder only appears there complete, with its `ready` file, so an
; interrupted unpack is redone on the next run.
;
; Built by scripts/build-windows-installer.mjs with -DVERSION, -DSTAGE and
; -DOUTFILE, plus -DPORTABLE for the portable build.

Unicode true
!include LogicLib.nsh
!include FileFunc.nsh

!ifdef PORTABLE
  !define ROOT "$LOCALAPPDATA\TeamClaude\portable\${VERSION}"
  SetCompressor /SOLID lzma
!else
  !define ROOT "$EXEDIR"
!endif

Name "TeamClaude"
OutFile "${OUTFILE}"
Icon "${STAGE}\teamclaude.ico"
RequestExecutionLevel user
SilentInstall silent
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "TeamClaude"
!ifdef PORTABLE
  VIAddVersionKey "FileDescription" "TeamClaude (portable)"
!else
  VIAddVersionKey "FileDescription" "TeamClaude"
!endif
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "KarpelesLab"
VIAddVersionKey "LegalCopyright" "MIT License"

Section
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--stop" $1
  ${IfNot} ${Errors}
    ; The bundled Node has its own image name, so this ends the proxy and no
    ; other Node program.
    nsExec::Exec 'taskkill /F /IM teamclaude-node.exe'
    Pop $1
    Quit
  ${EndIf}

!ifdef PORTABLE
  ${IfNot} ${FileExists} "${ROOT}\ready"
    ; Each launch unpacks into a folder of its own and renames it into place,
    ; so two first launches at once never write the same files. The one that
    ; loses the rename deletes its copy and runs from the other's.
    System::Call 'kernel32::GetCurrentProcessId() i .r9'
    StrCpy $8 "${ROOT}.unpack-$9"
    RMDir /r "$8"
    SetOverwrite try
    ClearErrors
    SetOutPath "$8\node"
    File "${STAGE}\node\teamclaude-node.exe"
    SetOutPath "$8\app"
    File /r "${STAGE}\app\*.*"
    ${IfNot} ${Errors}
      FileOpen $1 "$8\ready" w
      FileWrite $1 "${VERSION}"
      FileClose $1
    ${EndIf}
    ; Windows does not move or delete this process's working directory.
    SetOutPath "$TEMP"
    ${If} ${FileExists} "$8\ready"
      Rename "$8" "${ROOT}"
    ${EndIf}
    RMDir /r "$8"
    ${IfNot} ${FileExists} "${ROOT}\ready"
      MessageBox MB_OK|MB_ICONEXCLAMATION "TeamClaude could not unpack itself to$\r$\n${ROOT}$\r$\n$\r$\nCheck that the folder is writable and has room. If that folder exists, delete it and try again."
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!endif

  ; nsExec runs the console program with no window and hands back its exit
  ; code and output, so a proxy that fails to start says why instead of
  ; nothing happening.
  nsExec::ExecToStack '"${ROOT}\node\teamclaude-node.exe" "${ROOT}\app\src\index.js" desktop $0'
  Pop $1
  Pop $2
  ${If} $1 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "TeamClaude could not start.$\r$\n$\r$\n$2"
    SetErrorLevel 1
  ${EndIf}
SectionEnd
