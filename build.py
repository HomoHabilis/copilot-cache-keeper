"""Package the extension as a .vsix (a zip with a manifest) without needing vsce or network.
The version is taken from git tags (see build_version), not from package.json."""
import json, os, re, subprocess, zipfile, pathlib
here = pathlib.Path(__file__).parent
pkg = json.loads((here / "package.json").read_text())


def git(*args):
    try:
        return subprocess.run(["git", *args], cwd=here, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def build_version():
    """The version comes from git tags, never from package.json.
    VERSION set (the release workflow passes the tag): that version.
    Otherwise a dev build: next patch after the latest tag, then a build number, then the short
    commit, e.g. 0.8.2-dev.14.ab12cd3. It sorts above the tag's release (0.8.1) and below the next
    one (0.8.2), and a later build sorts above an earlier one, so each installs over the last.
    Build number: BUILD_NUMBER (CI passes its run number, which only goes up), else the number of
    commits since the tag. COMMIT overrides the commit (pull requests check out a merge commit)."""
    if os.environ.get("VERSION"):
        return os.environ["VERSION"].lstrip("v")
    commit = os.environ.get("COMMIT") or git("rev-parse", "HEAD") or "HEAD"
    tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", commit)
    major, minor, patch = (int(x) for x in re.match(r"v?(\d+)\.(\d+)\.(\d+)", tag or "v0.0.0").groups())
    n = os.environ.get("BUILD_NUMBER") or (git("rev-list", "--count", f"{tag}..{commit}") if tag else "") or "0"
    short = commit[:7] if commit != "HEAD" else "unknown"
    if short.isdigit():                 # semver forbids an all-digit identifier with a leading zero
        short = "g" + short
    return f"{major}.{minor}.{patch + 1}-dev.{int(n)}.{short}"


pkg["version"] = build_version()
if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", pkg["version"]):
    raise SystemExit(f"not a version: {pkg['version']}")
name = f"{pkg['publisher']}.{pkg['name']}"
manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}"/>
    <DisplayName>{pkg['displayName']}</DisplayName>
    <Description xml:space="preserve">{pkg['description']}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>"""
types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/><Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>"""
out = here / f"{pkg['name']}-{pkg['version']}.vsix"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", types)
    z.writestr("extension.vsixmanifest", manifest)
    z.writestr("extension/package.json", json.dumps(pkg, indent=2) + "\n")   # with the build's version
    for f in ("extension.js", "core.js", "README.md"):
        if (here / f).exists():
            z.write(here / f, f"extension/{f}")
print(out)
