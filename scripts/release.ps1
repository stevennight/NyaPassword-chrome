# Make an extension release: set the version (VERSION + package.json), pin the
# common commit the build uses (COMMON_REF), commit and tag v<version>.
# Pushing the tag makes GitHub Actions build the store zip and publish it.
# The manifest version is derived from VERSION by wxt.config.ts (x.y.z → x.y.z.1000).
#
#   .\scripts\release.ps1 0.1.0           # then: git push origin HEAD v0.1.0
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Version,
    [switch]$Push
)
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $repo '..\common\scripts\release-lib.ps1')
Get-NpwExtensionVersion $Version | Out-Null   # validates prerelease numbering
Publish-NpwVersion -Repo $repo -Product 'NyaPassword Chrome' -Jsons @('package.json') -Version $Version -Push:$Push
