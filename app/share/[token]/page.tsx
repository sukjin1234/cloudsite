import { SharedView } from "@/components/shared-view";

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedView token={token} />;
}
