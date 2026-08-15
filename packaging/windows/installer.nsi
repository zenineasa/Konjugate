; Copyright © 2026 Zenin Easa Panthakkalakath
;
; NSIS installer for Konjugate. Parameters are supplied by the Makefile via
; /D command-line defines rather than hard-coded here:
;   APP_NAME, APP_VERSION, APP_ID, SOURCE_DIR, ICON_PATH, LICENSE_PATH,
;   OUTPUT_FILE

!ifndef APP_NAME
  !error "APP_NAME must be defined"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION must be defined"
!endif
!ifndef APP_ID
  !error "APP_ID must be defined"
!endif
!ifndef SOURCE_DIR
  !error "SOURCE_DIR must be defined (packaged application directory)"
!endif
!ifndef ICON_PATH
  !error "ICON_PATH must be defined (.ico file)"
!endif
!ifndef LICENSE_PATH
  !error "LICENSE_PATH must be defined"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be defined"
!endif

!cd "../.."

!include "MUI2.nsh"

Name "${APP_NAME}"
OutFile "${OUTPUT_FILE}"
Unicode true
; Avoid solid compression here: the bundled Electron `app.asar` file causes NSIS to fail
; while creating a single mmap for the whole package. Standard per-file LZMA compression
; keeps installer output small without the GitHub Windows runner crash.
SetCompressor lzma
RequestExecutionLevel admin

InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "Software\${APP_ID}" "InstallDir"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 Zenin Easa Panthakkalakath"

!define MUI_ICON "${ICON_PATH}"
!define MUI_UNICON "${ICON_PATH}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_NAME}.exe"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_PATH}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

Section "-Application" SecApp
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"

  WriteRegStr HKLM "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe"

  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Zenin Easa Panthakkalakath"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_NAME}.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "Software\${APP_ID}"
SectionEnd
