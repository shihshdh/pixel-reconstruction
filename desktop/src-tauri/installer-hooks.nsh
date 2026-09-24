; 安装完成后，如果电脑有 D 盘，预先建好作品文件夹。
; 客户端会把原图、3D 场景和导出的视频存在这里；卸载时不会删除。
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "D:\*.*"
    CreateDirectory "D:\Pixel Reconstruction\作品"
  ${EndIf}
!macroend
