; Installer hooks for the Windows (NSIS) bundle.

!define OLD_NAME "Ethiopic Font Editor"

!macro NSIS_HOOK_POSTINSTALL
  ; Hohe used to be called "Ethiopic Font Editor". Tidy away what that name
  ; left behind: its Start menu and desktop shortcuts and its entry in
  ; Installed apps.
  ;
  ; Never run the old uninstaller or delete the old folder: an update can
  ; install Hohe into the old app's folder, and removing that folder removes
  ; Hohe itself (this happened with 0.1.9).
  Delete "$SMPROGRAMS\${OLD_NAME}.lnk"
  Delete "$DESKTOP\${OLD_NAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}"
!macroend
