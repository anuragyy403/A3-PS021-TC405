/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        night: {
          950: '#04060f',
          900: '#070b18',
          850: '#0a1020',
          800: '#0e1528',
        },
      },
      boxShadow: {
        glass: 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 24px 60px -32px rgba(2,4,12,0.95)',
        'glass-sm': 'inset 0 1px 0 0 rgba(255,255,255,0.05), 0 12px 30px -20px rgba(2,4,12,0.9)',
        'glow-sky': '0 0 0 1px rgba(56,189,248,0.3), 0 0 34px -10px rgba(56,189,248,0.55)',
      },
      keyframes: {
        /* A packet crossing the network channel. `left` is animated rather than a
           transform so the travel distance always matches the drawn track, no
           matter how the panel is resized. */
        'packet-fly': {
          '0%': { left: '0%', opacity: '0', transform: 'translate(-50%, -50%) scale(0.6)' },
          '8%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          '88%': { opacity: '1' },
          '100%': { left: '100%', opacity: '0', transform: 'translate(-50%, -50%) scale(0.6)' },
        },
        /* A packet travelling the other way, used for re-transmission. */
        'packet-fly-back': {
          '0%': { left: '100%', opacity: '0', transform: 'translate(-50%, -50%) scale(0.6)' },
          '10%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          '85%': { opacity: '1' },
          '100%': { left: '0%', opacity: '0', transform: 'translate(-50%, -50%) scale(0.6)' },
        },
        /* A marker that appears in place: faults, confirmations, restores. */
        'marker-pop': {
          '0%': { opacity: '0', transform: 'translate(-50%, -50%) scale(0.4)' },
          '55%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1.12)' },
          '100%': { opacity: '0', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'feed-in': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        /* Light travelling along the channel to show it is alive. */
        'channel-flow': {
          from: { backgroundPositionX: '0%' },
          to: { backgroundPositionX: '200%' },
        },
        'breathe': {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
        'sheen': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(320%)' },
        },
        'ring-out': {
          '0%': { boxShadow: '0 0 0 0 rgba(56,189,248,0.45)' },
          '70%': { boxShadow: '0 0 0 10px rgba(56,189,248,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(56,189,248,0)' },
        },
        'ring-out-amber': {
          '0%': { boxShadow: '0 0 0 0 rgba(251,191,36,0.5)' },
          '70%': { boxShadow: '0 0 0 10px rgba(251,191,36,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(251,191,36,0)' },
        },
        'ring-out-rose': {
          '0%': { boxShadow: '0 0 0 0 rgba(244,63,94,0.5)' },
          '70%': { boxShadow: '0 0 0 10px rgba(244,63,94,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(244,63,94,0)' },
        },
        'ring-out-emerald': {
          '0%': { boxShadow: '0 0 0 0 rgba(52,211,153,0.5)' },
          '70%': { boxShadow: '0 0 0 10px rgba(52,211,153,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(52,211,153,0)' },
        },
      },
      animation: {
        'packet-fly': 'packet-fly 1.15s cubic-bezier(0.4, 0, 0.6, 1) forwards',
        'packet-fly-back': 'packet-fly-back 1.15s cubic-bezier(0.4, 0, 0.6, 1) forwards',
        'marker-pop': 'marker-pop 1.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fade-up': 'fade-up 420ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'feed-in': 'feed-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'channel-flow': 'channel-flow 1.6s linear infinite',
        breathe: 'breathe 2.6s ease-in-out infinite',
        sheen: 'sheen 2.2s ease-in-out infinite',
        'ring-out': 'ring-out 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ring-out-amber': 'ring-out-amber 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ring-out-rose': 'ring-out-rose 1.1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ring-out-emerald': 'ring-out-emerald 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
