; 安装包的自定义脚本（electron-builder.yml 的 nsis.include）。
;
; 卸载时删掉自动更新的缓存目录 %LOCALAPPDATA%\<updaterCacheDirName>：安装程序复制过去的 installer.exe、
; 差分下载用的 blockmap、下载好的新版本（见 src/main/platform/update-cache.ts）。electron-builder 自带的卸载程序
; 不管这个目录，卸载后会留下两份安装包（200 多 MB）。
; 自动更新或手动覆盖安装时，旧版本的卸载程序带 --updated 运行（${isUpdated}）：这时新安装包可能正从这个目录运行，
; 之后的差分下载也还要用里面的 installer.exe，不删。
;
; 目录名不写死：取 electron-builder 定义的 APP_INSTALLER_STORE_FILE（<updaterCacheDirName>\installer.exe）去掉文件名。

!ifndef APP_INSTALLER_STORE_FILE
  !error "electron-builder 没有定义 APP_INSTALLER_STORE_FILE，认不出更新缓存目录"
!endif
!searchreplace CLOUDSSH_UPDATER_CACHE_DIR "${APP_INSTALLER_STORE_FILE}" "\installer.exe" ""
!if "${CLOUDSSH_UPDATER_CACHE_DIR}" == "${APP_INSTALLER_STORE_FILE}"
  !error "APP_INSTALLER_STORE_FILE 不是 <目录>\installer.exe：${APP_INSTALLER_STORE_FILE}"
!endif
!if "${CLOUDSSH_UPDATER_CACHE_DIR}" == ""
  !error "更新缓存目录名为空"
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 和安装程序一样：更新缓存总在当前用户的 LOCALAPPDATA 下，按所有用户安装时也是
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    DetailPrint "删除更新缓存 $LOCALAPPDATA\${CLOUDSSH_UPDATER_CACHE_DIR}"
    RMDir /r "$LOCALAPPDATA\${CLOUDSSH_UPDATER_CACHE_DIR}"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
