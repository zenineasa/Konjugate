# Draft Homebrew Cask for Konjugate -- NOT submitted anywhere yet.
#
# `eugenesvk/action-homebrew-bump-cask` (wired into .github/workflows/release.yml's
# homebrewCaskBump job) can only bump an *existing* cask's version -- it can't create the first
# one. This file is the starting point for that one-time first submission: copy it to
# `Casks/k/konjugate.rb` in a fork of Homebrew/homebrew-cask and open a PR there (see
# docs/packageManagerDistribution.md for the full one-time setup this depends on).
#
# sha256 values below are real, computed directly against the published v0.7.3 DMG release
# assets (not placeholders) -- but this file's own version/hashes will be stale by the time of
# submission if any release has shipped since. Re-verify version/sha256 against the latest
# release before submitting, and delete this comment block first.

cask "konjugate" do
  arch arm: "arm64", intel: "x64"

  version "0.7.3"
  sha256 arm:   "26a11757bda5bfedbfad91cbdba8e5c4be602123124e262930e253dbc3333f67",
         intel: "d1b9a9058471ef4f319da9a064559c73e120187a26742287b6d43aedaf697f0b"

  url "https://github.com/zenineasa/Konjugate/releases/download/v#{version}/Konjugate-#{version}-macos-#{arch}.dmg",
      verified: "github.com/zenineasa/Konjugate/"
  name "Konjugate"
  desc "Graph-native simulation engine for engineering and digital twins"
  homepage "https://github.com/zenineasa/Konjugate"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :big_sur

  app "Konjugate.app"

  caveats <<~EOS
    Konjugate is not code-signed or notarized yet (an active choice while the project is in
    alpha). If macOS reports that "Konjugate.app is damaged and can't be opened", run:
      xattr -cr "#{appdir}/Konjugate.app"
  EOS

  zap trash: [
    "~/Library/Application Support/Konjugate",
    "~/Library/Preferences/com.konjugate.plist",
    "~/Library/Saved Application State/com.konjugate.savedState",
  ]
end
