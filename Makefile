# Copyright © 2026 Zenin Easa Panthakkalakath

svgIcon := assets/icon.svg
iconDir := assets/icons
pngDir := $(iconDir)/png
iconsetDir := $(iconDir)/app.iconset
pngSizes := 16 24 32 48 64 128 256 512 1024
pngIcons := $(addprefix $(pngDir)/,$(addsuffix .png,$(pngSizes)))
appName := Konjugate
appId := com.konjugate
appVersion := $(shell node -p "require('./package.json').version")
packageDir := out/package
releaseDir := out/release
hostSystem := $(shell uname -s)
hostMachine := $(shell uname -m)
macSignIdentity ?=
appleNotaryProfile ?=

.DEFAULT_GOAL := build

ifeq ($(hostMachine),x86_64)
	hostArch := x64
	appImageArch := x86_64
else ifeq ($(hostMachine),amd64)
	hostArch := x64
	appImageArch := x86_64
else ifeq ($(hostMachine),aarch64)
	hostArch := arm64
	appImageArch := aarch64
else ifeq ($(hostMachine),arm64)
	hostArch := arm64
	appImageArch := aarch64
else
	hostArch := $(hostMachine)
	appImageArch := $(hostMachine)
endif

ifeq ($(hostSystem),Darwin)
	hostPlatform := darwin
else ifeq ($(hostSystem),Linux)
	hostPlatform := linux
else ifneq (,$(filter MINGW% MSYS% CYGWIN%,$(hostSystem)))
	hostPlatform := win32
else
	hostPlatform := unsupported
endif

.PHONY: \
	icons iconsPng iconsWindows iconsMacos iconsWeb cleanIcons \
	installDependencies checkPackaging packageApp packageMacos packageWindows packageLinux \
	distributable distributableMacos distributableWindows distributableLinux \
	build cleanPackage clean

build: icons
	@$(MAKE) distributable

icons: iconsPng iconsWindows iconsWeb

ifeq ($(hostPlatform),darwin)
icons: iconsMacos
endif

iconsPng: $(pngIcons) $(iconDir)/app.png

$(pngDir)/%.png: $(svgIcon)
	@command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert is required (install librsvg)."; exit 1; }
	@mkdir -p $(pngDir)
	rsvg-convert --width $* --height $* $< --output $@

$(iconDir)/app.png: $(pngDir)/512.png
	@mkdir -p $(iconDir)
	cp $< $@

iconsWindows: $(iconDir)/app.ico

$(iconDir)/app.ico: $(pngIcons) scripts/pngToIco.py
	python3 scripts/pngToIco.py \
		$(pngDir)/16.png \
		$(pngDir)/24.png \
		$(pngDir)/32.png \
		$(pngDir)/48.png \
		$(pngDir)/64.png \
		$(pngDir)/128.png \
		$(pngDir)/256.png \
		--output $@

iconsMacos: $(iconDir)/app.icns

$(iconDir)/app.icns: $(pngIcons)
	@command -v iconutil >/dev/null 2>&1 || { echo "iconutil is required to create app.icns (run this target on macOS)."; exit 1; }
	@mkdir -p $(iconsetDir)
	cp $(pngDir)/16.png $(iconsetDir)/icon_16x16.png
	cp $(pngDir)/32.png $(iconsetDir)/icon_16x16@2x.png
	cp $(pngDir)/32.png $(iconsetDir)/icon_32x32.png
	cp $(pngDir)/64.png $(iconsetDir)/icon_32x32@2x.png
	cp $(pngDir)/128.png $(iconsetDir)/icon_128x128.png
	cp $(pngDir)/256.png $(iconsetDir)/icon_128x128@2x.png
	cp $(pngDir)/256.png $(iconsetDir)/icon_256x256.png
	cp $(pngDir)/512.png $(iconsetDir)/icon_256x256@2x.png
	cp $(pngDir)/512.png $(iconsetDir)/icon_512x512.png
	cp $(pngDir)/1024.png $(iconsetDir)/icon_512x512@2x.png
	iconutil --convert icns --output $@ $(iconsetDir)
	rm -rf $(iconsetDir)

iconsWeb: $(iconDir)/favicon.ico $(iconDir)/favicon16.png $(iconDir)/favicon32.png $(iconDir)/appleTouchIcon.png

$(iconDir)/favicon.ico: $(pngIcons) scripts/pngToIco.py
	python3 scripts/pngToIco.py \
		$(pngDir)/16.png \
		$(pngDir)/32.png \
		$(pngDir)/48.png \
		--output $@

$(iconDir)/favicon16.png: $(pngDir)/16.png
	cp $< $@

$(iconDir)/favicon32.png: $(pngDir)/32.png
	cp $< $@

$(iconDir)/appleTouchIcon.png: $(svgIcon)
	rsvg-convert --width 180 --height 180 $< --output $@

cleanIcons:
	rm -rf $(iconDir)

installDependencies:
	@if [ ! -x node_modules/.bin/electron-packager ]; then \
		if [ -f package-lock.json ]; then npm ci; else npm install; fi; \
	fi

checkPackaging: installDependencies
	@test -x node_modules/.bin/electron-packager || { echo "Electron Packager installation failed."; exit 1; }

packageApp:
ifeq ($(hostPlatform),darwin)
	@$(MAKE) packageMacos
else ifeq ($(hostPlatform),win32)
	@$(MAKE) packageWindows
else ifeq ($(hostPlatform),linux)
	@$(MAKE) packageLinux
else
	@echo "Unsupported packaging host: $(hostSystem)"
	@exit 1
endif

packageMacos: checkPackaging iconsMacos
	node_modules/.bin/electron-packager . $(appName) \
		--platform=darwin \
		--arch=$(hostArch) \
		--app-bundle-id=$(appId) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.icns \
		--out=$(packageDir) \
		--overwrite \
		--prune=true

packageWindows: checkPackaging iconsWindows
	node_modules/.bin/electron-packager . $(appName) \
		--platform=win32 \
		--arch=$(hostArch) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.ico \
		--out=$(packageDir) \
		--overwrite \
		--prune=true

packageLinux: checkPackaging iconsPng
	node_modules/.bin/electron-packager . $(appName) \
		--platform=linux \
		--arch=$(hostArch) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.png \
		--out=$(packageDir) \
		--overwrite \
		--prune=true

distributable:
ifeq ($(hostPlatform),darwin)
	@$(MAKE) distributableMacos
else ifeq ($(hostPlatform),win32)
	@$(MAKE) distributableWindows
else ifeq ($(hostPlatform),linux)
	@$(MAKE) distributableLinux
else
	@echo "Unsupported distribution host: $(hostSystem)"
	@exit 1
endif

distributableMacos: packageMacos
	@command -v hdiutil >/dev/null 2>&1 || { echo "hdiutil is required to create a DMG."; exit 1; }
	@mkdir -p $(releaseDir)/dmg
	rm -rf $(releaseDir)/dmg/$(appName).app $(releaseDir)/dmg/Applications
	cp -R $(packageDir)/$(appName)-darwin-$(hostArch)/$(appName).app $(releaseDir)/dmg/
ifneq ($(strip $(macSignIdentity)),)
	codesign \
		--deep \
		--force \
		--options runtime \
		--timestamp \
		--sign "$(macSignIdentity)" \
		$(releaseDir)/dmg/$(appName).app
endif
	ln -s /Applications $(releaseDir)/dmg/Applications
	rm -f $(releaseDir)/$(appName)-$(appVersion)-macos-$(hostArch).dmg
	hdiutil create \
		-volname "$(appName)" \
		-srcfolder $(releaseDir)/dmg \
		-ov \
		-format UDZO \
		$(releaseDir)/$(appName)-$(appVersion)-macos-$(hostArch).dmg
ifneq ($(strip $(appleNotaryProfile)),)
	@test -n "$(macSignIdentity)" || { echo "macSignIdentity is required when notarizing."; exit 1; }
	xcrun notarytool submit \
		$(releaseDir)/$(appName)-$(appVersion)-macos-$(hostArch).dmg \
		--keychain-profile "$(appleNotaryProfile)" \
		--wait
	xcrun stapler staple $(releaseDir)/$(appName)-$(appVersion)-macos-$(hostArch).dmg
endif
	rm -rf $(releaseDir)/dmg
	@echo "Created $(releaseDir)/$(appName)-$(appVersion)-macos-$(hostArch).dmg"

distributableWindows: packageWindows
	@mkdir -p $(releaseDir)
	python3 scripts/createZip.py \
		$(packageDir)/$(appName)-win32-$(hostArch) \
		$(releaseDir)/$(appName)-$(appVersion)-windows-$(hostArch).zip
	@echo "Created $(releaseDir)/$(appName)-$(appVersion)-windows-$(hostArch).zip"

distributableLinux: packageLinux
	@command -v appimagetool >/dev/null 2>&1 || { echo "appimagetool is required to create an AppImage."; exit 1; }
	rm -rf $(releaseDir)/$(appName).AppDir
	@mkdir -p $(releaseDir)/$(appName).AppDir/usr/lib/konjugate
	cp -R $(packageDir)/$(appName)-linux-$(hostArch)/. $(releaseDir)/$(appName).AppDir/usr/lib/konjugate/
	cp packaging/linux/AppRun $(releaseDir)/$(appName).AppDir/AppRun
	cp packaging/linux/konjugate.desktop $(releaseDir)/$(appName).AppDir/konjugate.desktop
	cp $(iconDir)/app.png $(releaseDir)/$(appName).AppDir/konjugate.png
	cp $(iconDir)/app.png $(releaseDir)/$(appName).AppDir/.DirIcon
	chmod +x $(releaseDir)/$(appName).AppDir/AppRun
	ARCH=$(appImageArch) appimagetool \
		$(releaseDir)/$(appName).AppDir \
		$(releaseDir)/$(appName)-$(appVersion)-linux-$(hostArch).AppImage
	rm -rf $(releaseDir)/$(appName).AppDir
	@echo "Created $(releaseDir)/$(appName)-$(appVersion)-linux-$(hostArch).AppImage"

cleanPackage:
	rm -rf $(packageDir) $(releaseDir)

clean: cleanPackage cleanIcons
	rm -rf \
		node_modules \
		package-lock.json \
		out \
		scripts/__pycache__
