$ErrorActionPreference = "Stop"

$root = "D:\Assignment-9\rentora-server"
$targets = @(
    "$root\tests\bookingLifecycle.test.js",
    "$root\tests\payment.test.js",
    "$root\tests\run.js"
)

foreach ($file in $targets) {
    if (-not (Test-Path $file)) {
        throw "Required file not found: $file"
    }
}

$backup = "$root\test-fix-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $backup -Force | Out-Null

foreach ($file in $targets) {
    Copy-Item $file (Join-Path $backup ([IO.Path]::GetFileName($file))) -Force
}

function Replace-Once([string]$Content, [string]$Old, [string]$New, [string]$Label) {
    $Content = $Content -replace "`r`n", "`n"
    $Old = $Old -replace "`r`n", "`n"
    $New = $New -replace "`r`n", "`n"
    $count = ([regex]::Matches($Content, [regex]::Escape($Old))).Count
    if ($count -ne 1) {
        throw "Expected exactly one match for '$Label', found $count. No further changes should be made."
    }
    return $Content.Replace($Old, $New)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1) Lifecycle tests call the service directly, so this test worker must open
#    its own Mongoose connection to the isolated test database.
$file = "$root\tests\bookingLifecycle.test.js"
$content = [IO.File]::ReadAllText($file)
$content = Replace-Once $content "import { after, describe, it } from 'node:test';" "import { after, before, describe, it } from 'node:test';" "lifecycle test hooks"
$content = Replace-Once $content "import { runPendingBookingLifecycle } from '../services/bookingLifecycleService.js';" "import { connectToDatabase, closeDatabase } from '../config/db.js';`nimport { runPendingBookingLifecycle } from '../services/bookingLifecycleService.js';" "lifecycle database import"
$content = Replace-Once $content @"
  after(async () => {
    await closeTestDb();
  });
"@ @"
  before(async () => {
    await connectToDatabase();
  });

  after(async () => {
    await closeTestDb();
    await closeDatabase();
  });
"@ "lifecycle database setup/cleanup"
[IO.File]::WriteAllText($file, $content, $utf8NoBom)

# 2) Payment tests also invoke the Stripe webhook handler directly in the
#    test worker, outside the HTTP server process.
$file = "$root\tests\payment.test.js"
$content = [IO.File]::ReadAllText($file)
$content = Replace-Once $content "import { isStripeWebhookSecretConfigured } from '../services/stripeService.js';" "import { connectToDatabase, closeDatabase } from '../config/db.js';`nimport { isStripeWebhookSecretConfigured } from '../services/stripeService.js';" "payment database import"
$content = Replace-Once $content @"
  before(async () => {
    [renter, otherRenter, owner] = await Promise.all([
"@ @"
  before(async () => {
    await connectToDatabase();
    [renter, otherRenter, owner] = await Promise.all([
"@ "payment database setup"
$content = Replace-Once $content @"
  after(async () => {
    await closeTestDb();
  });
"@ @"
  after(async () => {
    await closeTestDb();
    await closeDatabase();
  });
"@ "payment database cleanup"
[IO.File]::WriteAllText($file, $content, $utf8NoBom)

# 3) The checkout test expects the API process itself to have no CLIENT_URL.
#    Clearing it in the test server environment makes that configuration test
#    deterministic; changing process.env in the test worker cannot change the
#    separate API server process.
$file = "$root\tests\run.js"
$content = [IO.File]::ReadAllText($file)
$content = Replace-Once $content "    CLIENT_URL: process.env.CLIENT_URL ?? 'http://localhost:3000'," "    CLIENT_URL: ''," "test server CLIENT_URL isolation"
[IO.File]::WriteAllText($file, $content, $utf8NoBom)

Write-Host ""
Write-Host "SUCCESS: Test database setup fixes applied." -ForegroundColor Green
Write-Host "Backup folder: $backup" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next run this command from the server folder:" -ForegroundColor Yellow
Write-Host "cd D:\Assignment-9\rentora-server; npm test" -ForegroundColor White
