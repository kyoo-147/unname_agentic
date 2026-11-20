param([string]$Root = 'C:\refs')
$ErrorActionPreference = 'Continue'
$repos = @(
  @{ Name = 'AgenticOCR';       Url = 'https://github.com/OpenDataLab/AgenticOCR.git' },
  @{ Name = 'OCR-Agent';        Url = 'https://github.com/AIGeeksGroup/OCR-Agent.git' },
  @{ Name = 'AgentOCR';         Url = 'https://github.com/langfengQ/AgentOCR.git' },
  @{ Name = 'pdf-lib';          Url = 'https://github.com/Hopding/pdf-lib.git' },
  @{ Name = 'OCRmyPDF';         Url = 'https://github.com/ocrmypdf/OCRmyPDF.git' },
  @{ Name = 'PDFMathTranslate'; Url = 'https://github.com/PDFMathTranslate/PDFMathTranslate.git' },
  @{ Name = 'BabelDOC';         Url = 'https://github.com/funstory-ai/BabelDOC.git' },
  @{ Name = 'docling';          Url = 'https://github.com/docling-project/docling.git' },
  @{ Name = 'paperless-ngx';    Url = 'https://github.com/paperless-ngx/paperless-ngx.git' },
  @{ Name = 'grobid';           Url = 'https://github.com/grobidOrg/grobid.git' }
)
$report = Join-Path $Root 'clones.txt'
"# shallow reference clones $(Get-Date -Format o)" | Set-Content $report
foreach ($repo in $repos) {
  $target = Join-Path $Root $repo.Name
  if (Test-Path (Join-Path $target '.git')) { "SKIP  $($repo.Name) (already present)" | Tee-Object -FilePath $report -Append; continue }
  $freeC = [math]::Round((Get-PSDrive C).Free / 1MB, 0)
  if ($freeC -lt 400) { "STOP  C: only $freeC MB free" | Tee-Object -FilePath $report -Append; break }
  $out = & git clone --depth 1 --single-branch $repo.Url $target 2>&1
  if ($LASTEXITCODE -eq 0) {
    $size = [math]::Round((Get-ChildItem $target -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 0)
    "OK    $($repo.Name)  ${size} MB" | Tee-Object -FilePath $report -Append
  } else {
    "FAIL  $($repo.Name): $($out | Select-Object -Last 1)" | Tee-Object -FilePath $report -Append
  }
}
"END freeC=$([math]::Round((Get-PSDrive C).Free / 1GB, 2))GB" | Tee-Object -FilePath $report -Append
