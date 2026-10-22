# 내 클라우드

Next.js, MySQL, 서버 파일 저장소를 사용하는 개인용 파일 보관 사이트입니다.

## 기능

- MySQL 계정과 비밀번호 기반 가입 및 로그인
- 폴더 생성, 이름 변경, 이동, 빈 폴더 삭제
- 파일 업로드, 검색, 다운로드, 미리보기
- Microsoft Office 온라인 미리보기
- 파일 및 폴더를 계정별로 분리
- 500MB까지 스트리밍 업로드와 다운로드

## MySQL 설정

MySQL 8.0.16 이상에서 [mysql/schema.sql](./mysql/schema.sql)을 실행합니다.

Windows PowerShell에서 실행:

```powershell
Get-Content -Raw .\mysql\schema.sql | mysql -u root -p
```

앱 전용 계정을 만들고 데이터베이스 접근 권한을 부여합니다. 아래 비밀번호를 `.env.local`의 `MYSQL_PASSWORD`와 동일하게 설정하세요.

```sql
CREATE USER 'cloudsite'@'127.0.0.1' IDENTIFIED BY 'your-mysql-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_cloud.* TO 'cloudsite'@'127.0.0.1';
```

`.env.local`에 아래 값을 설정하고, MySQL 비밀번호와 32자 이상 무작위 `SESSION_SECRET`을 입력합니다.

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=cloudsite
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=personal_cloud
SESSION_SECRET=your-long-random-secret
UPLOAD_DIR=./uploads
```

운영 환경에서는 앱 전용 MySQL 계정을 사용하고 `personal_cloud` 데이터베이스의 필요한 권한만 부여하세요.

## 실행

```bash
npm install
npm run dev
```

## 배포와 백업

앱은 MySQL에 연결하고 업로드 파일을 `UPLOAD_DIR`에 보관합니다. 따라서 영구 디스크와 Node.js 서버를 제공하는 환경에 배포하세요. Vercel 같은 임시 파일 시스템 환경에서는 업로드가 재시작이나 배포 후 유지되지 않습니다.

데이터를 보존하려면 MySQL 데이터베이스와 `UPLOAD_DIR`의 파일을 함께 백업해야 합니다. 두 저장소를 같은 시점으로 복구할 수 있도록 백업 일정을 맞추세요.

기존 Supabase 계정과 파일은 자동으로 옮겨지지 않습니다. 새 MySQL 데이터베이스는 비어 있는 상태로 시작합니다.

Office 파일 미리보기는 5분 동안 유효한 링크로 Microsoft Office 온라인 뷰어에 전달됩니다. 외부 뷰어 공유를 원하지 않는다면 해당 파일은 다운로드해 여세요.
