!macro customInstall
  ; Create .env from .env.example if .env doesn't exist
  IfFileExists "$INSTDIR\.env" env_exists env_missing
  env_missing:
    CopyFiles "$INSTDIR\.env.example" "$INSTDIR\.env"
  env_exists:
!macroend

!macro customUnInstall
  ; Leave .env intact on uninstall so user doesn't lose their keys
!macroend
