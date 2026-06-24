@echo off
title GitHub Push Tool - KomikZone
echo ===================================================
echo             GitHub Push Tool - KomikZone
echo ===================================================
echo.
echo Silakan masukkan Personal Access Token (PAT) GitHub Anda.
echo (Token ini hanya digunakan sementara untuk push dan tidak akan disimpan)
echo.
set /p token="PAT GitHub: "
if "%token%"=="" (
    echo.
    echo [ERROR] Token tidak boleh kosong!
    echo.
    pause
    exit /b
)

echo.
echo [+] Mengonfigurasi remote URL dengan token Anda...
git remote set-url origin https://%token%@github.com/DkGaming12/komikzone.git

echo.
echo [+] Memulai proses FORCE push ke GitHub (master) untuk memperbarui email commit...
git push -f -u origin master

echo.
echo [+] Membersihkan token dari konfigurasi Git lokal (keamanan)...
git remote set-url origin https://github.com/DkGaming12/komikzone.git

echo.
echo [✓] Selesai! Perubahan Anda telah ter-push dengan email baru Anda.
echo.
pause
