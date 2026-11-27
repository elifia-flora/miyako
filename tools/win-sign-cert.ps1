# 造一张一次性的 Authenticode 自签名证书，主体 CN=elifia-flora。
# 私钥不进仓库：每次打 Windows 包时现做、导出 pfx。
# 不用 Cert: 驱动器。GitHub Actions 上的 PowerShell 7 没有这块盘，
# New-SelfSignedCertificate -CertStoreLocation 会直接失败。
# 这张证书不在任何公共 CA 上，SmartScreen 仍会显示未知发布者；
# 文件属性的「数字签名」里能看到签名者是 elifia-flora。
$ErrorActionPreference = 'Stop'

$subject = 'CN=elifia-flora'
$passwordPlain = 'elifia-flora'
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'miyako-elifia-flora.pfx'
if (Test-Path -LiteralPath $out) {
  Remove-Item -LiteralPath $out -Force
}

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $subject,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add('1.3.6.1.5.5.7.3.3')
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
      $false
    )
  )
  $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
  $notAfter = [DateTimeOffset]::UtcNow.AddYears(5)
  $cert = $request.CreateSelfSigned($notBefore, $notAfter)
  try {
    $pwd = ConvertTo-SecureString -String $passwordPlain -Force -AsPlainText
    $bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pwd)
    [System.IO.File]::WriteAllBytes($out, $bytes)
  }
  finally {
    $cert.Dispose()
  }
}
finally {
  $rsa.Dispose()
}

Write-Output "PFX=$out"
Write-Output "PASSWORD=$passwordPlain"
