import { Boombox } from "@/components/boombox/Boombox";

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[radial-gradient(ellipse_at_center,#e8d8ba_0%,#c7ae88_100%)] p-4 sm:p-8">
      <Boombox />
      <p className="text-xs uppercase tracking-[0.25em] text-stone-800">Press space to play or pause</p>
    </main>
  );
}

export default App;
