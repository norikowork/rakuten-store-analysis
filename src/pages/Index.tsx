import { useState, useEffect } from "react";

const messages = [
  "Building your app...",
  "アプリを作成中...",
  "Bygger din app...",
];

const Index = () => {
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % messages.length);
        setFade(true);
      }, 400);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <div className="text-center">
        {/* Kliv logo */}
        <div className="flex justify-center mb-8">
          <svg width="120" viewBox="0 0 761.19 218.11" xmlns="http://www.w3.org/2000/svg">
            <rect fill="none" className="stroke-slate-200 dark:stroke-slate-600" strokeMiterlimit="10" strokeWidth="15.59" x="7.8" y="7.8" width="86.6" height="86.6" rx="11.4" ry="11.4"/>
            <rect fill="none" className="stroke-slate-200 dark:stroke-slate-600" strokeMiterlimit="10" strokeWidth="15.59" x="125.36" y="7.8" width="86.6" height="86.6" rx="11.4" ry="11.4"/>
            <rect fill="none" className="stroke-slate-200 dark:stroke-slate-600" strokeMiterlimit="10" strokeWidth="15.59" x="7.8" y="123.71" width="86.6" height="86.6" rx="11.4" ry="11.4"/>
            <rect fill="#1b6cb6" x="118.39" y="117.44" width="100.54" height="100.54" rx="13.23" ry="13.23"/>
            <g className="fill-slate-700 dark:fill-slate-200">
              <path d="M299.37,2.8v104.29L403.66,2.8h40.16l-89.61,86.91,92.01,128.27h-37.76l-75.22-107.89-33.87,32.37v75.52h-29.07V2.8h29.07Z"/>
              <path d="M504.96,2.8v215.18h-26.37V2.8h26.37Z"/>
              <path d="M582.57,2.8v29.97h-26.37V2.8h26.37ZM582.57,61.24v156.74h-26.37V61.24h26.37Z"/>
              <path d="M646.7,61.24l40.76,127.67h.6l44.36-127.67h28.77l-59.64,156.74h-28.17l-57.24-156.74h30.57Z"/>
            </g>
          </svg>
        </div>

        {/* Loading indicator */}
        <div className="flex items-center justify-center gap-1.5 mb-8">
          <div className="animate-bounce w-1.5 h-1.5 rounded-full bg-blue-400" style={{ animationDelay: "0ms" }} />
          <div className="animate-bounce w-1.5 h-1.5 rounded-full bg-blue-400" style={{ animationDelay: "150ms" }} />
          <div className="animate-bounce w-1.5 h-1.5 rounded-full bg-blue-400" style={{ animationDelay: "300ms" }} />
        </div>

        {/* Rotating message */}
        <p
          className="text-sm text-slate-400 dark:text-slate-500 transition-opacity duration-400"
          style={{ opacity: fade ? 1 : 0 }}
        >
          {messages[index]}
        </p>
      </div>
    </div>
  );
};

export default Index;
