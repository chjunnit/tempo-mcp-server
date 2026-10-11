$gitPath = "C:\Users\ChristopherJuhl(CHJU\AppData\Local\Programs\Git\bin\git.exe"

Write-Host "GitHub Push Helper"
Write-Host "=================="
Write-Host ""
Write-Host "When prompted, enter:"
Write-Host "  Username: chjunnit"
Write-Host "  Password: [Your Personal Access Token - starts with ghp_]"
Write-Host ""

& $gitPath push -u origin master
