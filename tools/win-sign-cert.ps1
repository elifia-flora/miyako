# 造一张一次性的 Authenticode 自签名证书，主体 CN=elifia-flora。
# 私钥不进仓库：每次打 Windows 包时现做、导出 pfx、用完从证书库删掉。
# 这张证书不在任何公共 CA 上，SmartScreen 仍会显示未知发布者；
# 文件属性的「数字签名」里能看到签名者是 elifia-flora。
$ErrorActionPreference = 'Stop'

$subject = 'CN=elifia-flora'
$passwordPlain = 'elifia-flora'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'miyako-elifia-flora.pfx'
if (Test-Path -LiteralPath $out) {
  Remove-Item -LiteralPath $out -Force
}

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -FriendlyName 'elifia-flora' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -HashAlgorithm SHA256 `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(5)

try {
  $pwd = ConvertTo-SecureString -String $passwordPlain -Force -AsPlainText
  Export-PfxCertificate -Cert $cert -FilePath $out -Password $pwd | Out-Null
}
finally {
  Remove-Item -LiteralPath $cert.PSPath -Force
}

Write-Output "PFX=$out"
Write-Output "PASSWORD=$passwordPlain"
