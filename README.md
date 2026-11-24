# Bus Fever Cocos MVP

基于 Cocos Creator 3.8.8 的可玩首关工程。项目包含 TypeScript 源码、场景、Android 构建配置，以及运行所需的模型、贴图和动画资源。

## 运行

1. 安装 Cocos Creator 3.8.8，导入仓库根目录。
2. 在资源面板打开 `assets/OwnedArtGameplay.scene`，启动预览。
3. 等乘客进入环道后，按颜色发车。满员车辆会离场，最后一辆车离场后进入胜利结算。

## 构建 Android

在 Creator 构建面板选 Android，启动场景选 `OwnedArtGameplay`，ABI 选 `arm64-v8a`，使用调试签名。仓库根目录的 `android-build.json` 提供这套构建配置。SDK、NDK 和 JDK 使用本机 Creator 配置。

当前版本已在 Android 15 ARM64 模拟器验证并行进站、240 人登车、六车离场、胜负、领取金币、暂停与重开。行车曲线和部分动画时序依据首关录像拟合，仍在逐项对照。

## Android 整关验收

首关使用 240 名独立乘客，每辆车有 40 个座位。回放逐一核对上车记录，并验证并行进站、满位失败、通关领奖、暂停与重开。乘客按录像估算的间距进场。

在 Android 15 ARM64、1080×2400 的模拟器上安装候选 APK，待设备连接 adb 后执行以下命令。脚本需要 Bash、adb、Python 3、jq、rg、xxd 和 shasum。证据目录会保存截图、录像、运行事件及逐车计数。

```sh
adb -s emulator-5586 install -r "$apk"
bash tools/replay_level_one.sh "$apk" "$evidence" emulator-5586
```

环道按原 Prefab 的 39 个位置运行，每个位置按五人一排显示。空位随环道转动，经过右上入口时由候车乘客补入；同色车辆停稳且乘客经过出口区间时开始登车。录屏对照采用约每秒 0.115 圈的拟合速度。
