import type { Metadata } from "next";
import "./globals.css";

// الواجهة عربية بالكامل (RTL) مع خط Cairo الجيد للعربية
export const metadata: Metadata = {
  title: "لوحة إدارة مولد الوسائط MCP",
  description:
    "خادم MCP لتوليد الصور والفيديوهات بالذكاء الاصطناعي ودمج المقاطع — مع تبديل تلقائي بين مفاتيح API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground">{children}</body>
    </html>
  );
}
