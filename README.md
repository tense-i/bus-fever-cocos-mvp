# Bus Fever Cocos MVP

基于 Cocos Creator 3.8.8 的可玩首关工程。项目包含 TypeScript 源码、场景、Android 构建配置，以及运行所需的模型、贴图和动画资源。

## 运行

1. 安装 Cocos Creator 3.8.8，导入仓库根目录。
2. 在资源面板打开 `assets/OwnedArtGameplay.scene`，启动预览。
3. 等乘客进入环道后，按颜色发车。满员车辆会离场，最后一辆车离场后进入胜利结算。

## 构建 Android

在 Creator 构建面板选 Android，启动场景选 `OwnedArtGameplay`，ABI 选 `arm64-v8a`，使用调试签名。仓库根目录的 `android-build.json` 提供这套构建配置。SDK、NDK 和 JDK 使用本机 Creator 配置。

当前版本已在 Android 15 ARM64 模拟器验证并行进站、240 人登车、六车离场、胜负、领取金币、暂停与重开。行车曲线和部分动画时序依据首关录像拟合，仍在逐项对照。
