# Copyright © 2026 Zenin Easa Panthakkalakath

svgIcon := assets/icon.svg
iconDir := assets/icons
pngDir := $(iconDir)/png
pngSizes := 16 24 32 48 64 128 256 512 1024
pngIcons := $(addprefix $(pngDir)/,$(addsuffix .png,$(pngSizes)))
appName := Konjugate
appId := com.konjugate
appVersion := $(shell node -p "require('./package.json').version")
packageDir := out/package
releaseDir := out/release
enginePackageDir := out/packageResources/engine
ifeq ($(OS),Windows_NT)
	hostSystem := Windows
	ifeq ($(PROCESSOR_ARCHITEW6432),AMD64)
		hostMachine := x86_64
	else ifeq ($(PROCESSOR_ARCHITEW6432),ARM64)
		hostMachine := arm64
	else ifeq ($(PROCESSOR_ARCHITECTURE),AMD64)
		hostMachine := x86_64
	else ifeq ($(PROCESSOR_ARCHITECTURE),ARM64)
		hostMachine := arm64
	else
		hostMachine := $(PROCESSOR_ARCHITECTURE)
	endif
else
	hostSystem := $(shell uname -s)
	hostMachine := $(shell uname -m)
endif
macSignIdentity ?=
appleNotaryProfile ?=

.DEFAULT_GOAL := build

ifeq ($(hostMachine),x86_64)
	hostArch := x64
	appImageArch := x86_64
else ifeq ($(hostMachine),AMD64)
	hostArch := x64
	appImageArch := x86_64
else ifeq ($(hostMachine),amd64)
	hostArch := x64
	appImageArch := x86_64
else ifeq ($(hostMachine),ARM64)
	hostArch := arm64
	appImageArch := aarch64
else ifeq ($(hostMachine),aarch64)
	hostArch := arm64
	appImageArch := aarch64
else ifeq ($(hostMachine),arm64)
	hostArch := arm64
	appImageArch := aarch64
else ifeq ($(hostMachine),x86)
	hostArch := ia32
	appImageArch := i686
else ifeq ($(hostMachine),i386)
	hostArch := ia32
	appImageArch := i686
else ifeq ($(hostMachine),i486)
	hostArch := ia32
	appImageArch := i686
else ifeq ($(hostMachine),i586)
	hostArch := ia32
	appImageArch := i686
else ifeq ($(hostMachine),i686)
	hostArch := ia32
	appImageArch := i686
else ifeq ($(hostMachine),ia32)
	hostArch := ia32
	appImageArch := i686
else
	hostArch := $(hostMachine)
	appImageArch := $(hostMachine)
endif

ifeq ($(hostSystem),Darwin)
	hostPlatform := darwin
else ifeq ($(hostSystem),Linux)
	hostPlatform := linux
else ifeq ($(hostSystem),Windows)
	hostPlatform := win32
else ifneq (,$(filter MINGW% MSYS% CYGWIN%,$(hostSystem)))
	hostPlatform := win32
else
	hostPlatform := unsupported
endif

ifeq ($(OS),Windows_NT)
	RM := node -e "const fs=require('fs'); for (const p of process.argv.slice(1)) fs.rmSync(p, {recursive: true, force: true});"
	RM_F := node -e "const fs=require('fs'); for (const p of process.argv.slice(1)) fs.rmSync(p, {force: true});"
	MKDIR := node -e "const fs=require('fs'); fs.mkdirSync(process.argv[1], {recursive: true});"
	CP := node -e "const fs=require('fs'); fs.copyFileSync(process.argv[1], process.argv[2]);"
	CP_R := node -e "const fs=require('fs'); fs.cpSync(process.argv[1], process.argv[2], {recursive: true});"
	PYTHON := python
else
	RM := rm -rf
	RM_F := rm -f
	MKDIR := mkdir -p
	CP := cp
	CP_R := cp -R
	PYTHON := python3
endif

.PHONY: \
	icons iconsPng iconsWindows iconsMacos iconsWeb cleanIcons \
	engine \
	installDependencies checkPackaging packageApp packageMacos packageWindows packageLinux \
	distributable distributableMacos distributableWindows distributableWindowsPortable distributableLinux \
	verifyPackagedEngine verifyPackagedInteraction verifyPackage \
	build cleanPackage clean

build: icons
	@$(MAKE) distributable

icons: iconsPng iconsWindows iconsWeb

ifeq ($(hostPlatform),darwin)
icons: iconsMacos
endif

iconsPng: $(pngIcons) $(iconDir)/app.png

ifeq ($(OS),Windows_NT)
$(pngDir)/%.png: $(svgIcon)
	@where rsvg-convert >nul 2>nul || (echo rsvg-convert is required - please install librsvg. && exit 1)
	@$(MKDIR) $(pngDir)
	rsvg-convert --width $* --height $* $< --output $@
else
$(pngDir)/%.png: $(svgIcon)
	@command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert is required (install librsvg)."; exit 1; }
	@$(MKDIR) $(pngDir)
	rsvg-convert --width $* --height $* $< --output $@
endif

$(iconDir)/app.png: $(pngDir)/512.png
	@$(MKDIR) $(iconDir)
	$(CP) $< $@

iconsWindows: $(iconDir)/app.ico

$(iconDir)/app.ico: $(pngIcons) scripts/pngToIco.py
	$(PYTHON) scripts/pngToIco.py \
		$(pngDir)/16.png \
		$(pngDir)/24.png \
		$(pngDir)/32.png \
		$(pngDir)/48.png \
		$(pngDir)/64.png \
		$(pngDir)/128.png \
		$(pngDir)/256.png \
		--output $@

iconsMacos: $(iconDir)/app.icns

$(iconDir)/app.icns: $(pngIcons) scripts/pngToIcns.mjs
	node scripts/pngToIcns.mjs \
		--icons=$(pngDir) \
		--output=$@

iconsWeb: $(iconDir)/favicon.ico $(iconDir)/favicon16.png $(iconDir)/favicon32.png $(iconDir)/appleTouchIcon.png

$(iconDir)/favicon.ico: $(pngIcons) scripts/pngToIco.py
	$(PYTHON) scripts/pngToIco.py \
		$(pngDir)/16.png \
		$(pngDir)/32.png \
		$(pngDir)/48.png \
		--output $@

$(iconDir)/favicon16.png: $(pngDir)/16.png
	$(CP) $< $@

$(iconDir)/favicon32.png: $(pngDir)/32.png
	$(CP) $< $@

$(iconDir)/appleTouchIcon.png: $(svgIcon)
	rsvg-convert --width 180 --height 180 $< --output $@

cleanIcons:
	$(RM) $(iconDir)

installDependencies:
	@node -e "try { require('@electron/packager'); } catch (e) { const fs = require('fs'); const cmd = fs.existsSync('package-lock.json') ? 'npm ci' : 'npm install'; require('child_process').execSync(cmd, { stdio: 'inherit' }); }"

checkPackaging: installDependencies
	@node -e "try { require('@electron/packager'); } catch (e) { console.error('Electron Packager installation failed.'); process.exit(1); }"

engine: installDependencies
	node scripts/setupDevelopment.mjs
	node scripts/buildEngine.mjs --install

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

# Runs the engine/interaction test suites against the packaged app rather than the dev build --
# catches packaging-only failures (missing bundled libraries, resource paths that only resolve
# once actually laid out the way the packager produces, code-signing side effects) that dev-mode
# testing structurally cannot. Slower than the dev-mode suites since each depends on a fresh
# package build; treat as a pre-release check, not a fast dev-loop one.
verifyPackagedEngine: packageApp
	node scripts/testPackagedEngine.mjs

verifyPackagedInteraction: packageApp
	node scripts/runPackagedInteractionTests.mjs

verifyPackage: verifyPackagedEngine verifyPackagedInteraction

packageMacos: checkPackaging iconsMacos engine
	npx electron-packager . $(appName) \
		--platform=darwin \
		--arch=$(hostArch) \
		--app-bundle-id=$(appId) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.icns \
		--extra-resource=$(enginePackageDir) \
		--extra-resource=thirdPartyNotices.md \
		--extra-resource=thirdPartyLicenses \
		--ignore="^/out($|/)" \
		--ignore="^/\.tools($|/)" \
		--out=$(packageDir) \
		--overwrite \
		--prune=true
	node scripts/verifyPackagingNotices.mjs \
		$(packageDir)/$(appName)-darwin-$(hostArch)/$(appName).app/Contents/Resources

packageWindows: checkPackaging iconsWindows engine
	npx electron-packager . $(appName) \
		--platform=win32 \
		--arch=$(hostArch) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.ico \
		--extra-resource=$(enginePackageDir) \
		--extra-resource=thirdPartyNotices.md \
		--extra-resource=thirdPartyLicenses \
		--ignore="^/out($|/)" \
		--ignore="^/\.tools($|/)" \
		--out=$(packageDir) \
		--overwrite \
		--prune=true
	node scripts/verifyPackagingNotices.mjs \
		$(packageDir)/$(appName)-win32-$(hostArch)/resources

packageLinux: checkPackaging iconsPng engine
	npx electron-packager . $(appName) \
		--platform=linux \
		--arch=$(hostArch) \
		--app-version=$(appVersion) \
		--icon=$(iconDir)/app.png \
		--extra-resource=$(enginePackageDir) \
		--extra-resource=thirdPartyNotices.md \
		--extra-resource=thirdPartyLicenses \
		--ignore="^/out($|/)" \
		--ignore="^/\.tools($|/)" \
		--out=$(packageDir) \
		--overwrite \
		--prune=true
	node scripts/verifyPackagingNotices.mjs \
		$(packageDir)/$(appName)-linux-$(hostArch)/resources

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
	@where makensis >nul 2>nul || (echo makensis is required to create the Windows installer - please install NSIS. && exit 1)
	@$(MKDIR) $(releaseDir)
	makensis \
		-DAPP_NAME=$(appName) \
		-DAPP_VERSION=$(appVersion) \
		-DAPP_ID=$(appId) \
		-DSOURCE_DIR=$(packageDir)/$(appName)-win32-$(hostArch) \
		-DICON_PATH=$(iconDir)/app.ico \
		-DLICENSE_PATH=LICENSE \
		-DOUTPUT_FILE=$(releaseDir)/$(appName)-$(appVersion)-windows-$(hostArch)-setup.exe \
		packaging/windows/installer.nsi
	@echo "Created $(releaseDir)/$(appName)-$(appVersion)-windows-$(hostArch)-setup.exe"

distributableWindowsPortable: packageWindows
	@$(MKDIR) $(releaseDir)
	$(PYTHON) scripts/createZip.py \
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
	$(RM) $(packageDir) $(releaseDir)

cleanVCPKG:
	$(RM) .tools/vcpkg/buildtrees
	$(RM) .tools/vcpkg/packages

cleanWorkspace:
	$(RM) node_modules
	$(RM) package-lock.json
	$(RM) out
	$(RM) scripts/__pycache__

clean: cleanPackage cleanIcons cleanVCPKG cleanWorkspace
