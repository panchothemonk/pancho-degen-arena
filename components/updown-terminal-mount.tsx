"use client";

import dynamic from "next/dynamic";

const UpDownTerminal = dynamic(() => import("@/components/updown-terminal"), {
  ssr: false
});

export default function UpDownTerminalMount() {
  return <UpDownTerminal />;
}

