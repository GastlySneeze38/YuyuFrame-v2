/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'rgb(var(--bg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--bg-secondary) / <alpha-value>)',
          card: 'rgb(var(--bg-card) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
        },
        txt: {
          primary: 'rgb(var(--txt-primary) / <alpha-value>)',
          secondary: 'rgb(var(--txt-secondary) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 2s linear infinite',
        'float': 'float 5s ease-in-out infinite',
        'float-slow': 'float 8s ease-in-out infinite',
        'banner-flash': 'bannerFlash 1.1s ease-out forwards',
        'banner-glow': 'bannerGlow 2s ease-in-out infinite',
        'terrain-float': 'terrainFloat 3s ease-in-out infinite',
        'star-pulse': 'starPulse 2s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        bannerFlash: {
          '0%': { opacity: '0' },
          '12%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        bannerGlow: {
          '0%, 100%': { opacity: '0.2' },
          '50%': { opacity: '1' },
        },
        terrainFloat: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        starPulse: {
          '0%, 100%': { filter: 'brightness(0.6)' },
          '50%': { filter: 'brightness(5)' },
        },
      },
    },
  },
  plugins: [],
}
