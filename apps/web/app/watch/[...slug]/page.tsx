import React from "react";
import WatchBoard from "../WatchBoard";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export default async function WatchSlugPage({ params }: Props) {
  const { slug } = await params;
  const traceName = slug && slug.length > 0 ? slug.join("/") : "takeover";

  return <WatchBoard initialTraceId={traceName} />;
}
