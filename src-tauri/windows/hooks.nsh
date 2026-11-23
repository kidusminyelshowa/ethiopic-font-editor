; Installer hooks for the Windows (NSIS) bundle.

!macro NSIS_HOOK_POSTINSTALL
  ; Hohe used to be called "Ethiopic Font Editor", which installed into its own
  ; folder with its own shortcut and uninstall entry. Remove that copy so only
  ; Hohe is left. App data is keyed by the bundle identifier, which did not
  ; change, and the silent uninstaller leaves it alone.
  IfFileExists "$LOCALAPPDATA\Ethiopic Font Editor\uninstall.exe" 0 +3
    ExecWait '"$LOCALAPPDATA\Ethiopic Font Editor\uninstall.exe" /S _?=$LOCALAPPDATA\Ethiopic Font Editor'
    RMDir /r "$LOCALAPPDATA\Ethiopic Font Editor"
!macroend
