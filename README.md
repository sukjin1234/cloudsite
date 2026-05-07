# Personal Cloud Site

Supabase Auth, Postgres, Storage, and Vercel deployment을 전제로 만든 개인용 클라우드 파일 보관 사이트입니다.

## 기능

- Supabase 이메일/비밀번호 로그인
- 폴더 생성, 이동, 이름 변경, 빈 폴더 삭제
- 현재 폴더에 여러 파일 업로드
- 파일 목록 검색
- 이미지, PDF, 텍스트/Markdown/JSON/CSV, 오디오, 비디오 미리보기
- Word/Excel/PowerPoint 파일은 Microsoft Office 온라인 뷰어 임베드로 미리보기
- Supabase Storage signed URL 기반 다운로드
- 사용자별 RLS로 폴더, 파일 메타데이터, Storage 객체 격리

## Supabase 설정

1. Supabase 프로젝트를 생성합니다.
2. SQL Editor에서 [supabase/schema.sql](./supabase/schema.sql)을 실행합니다.
3. Authentication > Providers에서 Email provider를 활성화합니다.
4. 개인용으로 쓸 계정을 Supabase Auth에서 만들거나, 앱의 가입 버튼으로 생성합니다.
5. Project Settings > API에서 URL과 anon key를 확인합니다.

## 로컬 실행

`.env.local`을 만들고 아래 값을 채웁니다.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
```

의존성 설치와 실행:

```bash
npm install
npm run dev
```

## Vercel 배포

1. 이 프로젝트를 GitHub에 올립니다.
2. Vercel에서 새 프로젝트로 import합니다.
3. Vercel Environment Variables에 `.env.example`의 두 값을 등록합니다.
4. Deploy를 실행합니다.

Office 파일 미리보기는 signed URL을 Microsoft Office 온라인 뷰어에 전달합니다. 외부 뷰어 공유가 싫다면 해당 형식은 다운로드로만 사용하세요.
