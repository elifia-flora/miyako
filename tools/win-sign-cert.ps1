# One-shot Authenticode cert, subject CN=elifia-flora.
# Do not use the Cert: drive or a SecureString.
# GitHub Actions PowerShell cannot load Microsoft.PowerShell.Security.
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
    $bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $passwordPlain)
    if ($null -eq $bytes -or $bytes.Length -eq 0) {
      throw 'PFX export returned no bytes'
    }
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
