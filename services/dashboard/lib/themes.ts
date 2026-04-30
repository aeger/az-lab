export type ThemeName =
  | 'default'
  | 'halloween'
  | 'christmas'
  | 'newyear'
  | 'valentine'
  | 'stpatricks'
  | 'july4'

export interface HolidayTheme {
  name: ThemeName
  label: string
  emoji: string
  banner: string
  /** CSS custom property overrides injected into :root */
  tokens: Record<string, string>
  /** Particles/decorations rendered in the layout */
  particles?: string
  /** Snow effect */
  snow?: boolean
  /** Active date ranges: [month, dayStart, dayEnd] — month is 1-based */
  schedule: Array<[number, number, number]>
}

export const THEMES: Record<ThemeName, HolidayTheme> = {
  default: {
    name: 'default',
    label: 'Default',
    emoji: '',
    banner: '',
    tokens: {},
    schedule: [],
  },
  halloween: {
    name: 'halloween',
    label: 'Halloween',
    emoji: '🎃',
    banner: '🎃  Happy Halloween from AZ-Lab!  👻',
    schedule: [[10, 25, 31]],
    tokens: {
      '--accent-h': '28',
      '--accent-s': '100%',
      '--accent-l': '55%',
      '--bg-page': '#0d0a00',
      '--bg-card': 'rgba(25,15,0,0.7)',
      '--border-base': 'rgba(180,80,0,0.35)',
    },
    particles: '🎃 👻 🕷️ 🦇',
  },
  christmas: {
    name: 'christmas',
    label: 'Christmas',
    emoji: '🎄',
    banner: "🎄  Season's Greetings from AZ-Lab!  ❄️",
    schedule: [[12, 1, 31]],
    tokens: {
      '--accent-h': '142',
      '--accent-s': '70%',
      '--accent-l': '45%',
      '--bg-page': '#020b08',
      '--bg-card': 'rgba(4,20,12,0.7)',
      '--border-base': 'rgba(22,101,52,0.5)',
    },
    particles: '🎄 ⭐ 🎁',
    snow: true,
  },
  newyear: {
    name: 'newyear',
    label: 'New Year',
    emoji: '✨',
    banner: '🎆  Happy New Year from AZ-Lab!  🥂',
    schedule: [[1, 1, 3], [12, 31, 31]],
    tokens: {
      '--accent-h': '270',
      '--accent-s': '80%',
      '--accent-l': '65%',
      '--bg-page': '#050310',
      '--bg-card': 'rgba(10,5,25,0.7)',
      '--border-base': 'rgba(124,58,237,0.4)',
    },
    particles: '✨ 🎆 🥂 🎊',
  },
  valentine: {
    name: 'valentine',
    label: "Valentine's",
    emoji: '💕',
    banner: "💕  Happy Valentine's Day!  ❤️",
    schedule: [[2, 12, 14]],
    tokens: {
      '--accent-h': '340',
      '--accent-s': '75%',
      '--accent-l': '60%',
      '--bg-page': '#100508',
      '--bg-card': 'rgba(28,8,15,0.7)',
      '--border-base': 'rgba(159,18,57,0.35)',
    },
    particles: '💕 ❤️ 💝',
  },
  stpatricks: {
    name: 'stpatricks',
    label: "St. Patrick's",
    emoji: '☘️',
    banner: "☘️  Happy St. Patrick's Day!  🍀",
    schedule: [[3, 17, 17]],
    tokens: {
      '--accent-h': '130',
      '--accent-s': '70%',
      '--accent-l': '45%',
      '--bg-page': '#020d04',
      '--bg-card': 'rgba(5,22,8,0.7)',
      '--border-base': 'rgba(21,128,61,0.4)',
    },
    particles: '☘️ 🍀 🌈',
  },
  july4: {
    name: 'july4',
    label: 'July 4th',
    emoji: '🎆',
    banner: '🎆  Happy Independence Day!  🇺🇸',
    schedule: [[7, 4, 4]],
    tokens: {
      '--accent-h': '220',
      '--accent-s': '80%',
      '--accent-l': '60%',
      '--bg-page': '#020310',
      '--bg-card': 'rgba(5,7,30,0.7)',
      '--border-base': 'rgba(30,58,138,0.5)',
    },
    particles: '🎆 🇺🇸 🎇',
  },
}

/**
 * Returns the active holiday theme for a given date, or null for default.
 * Checks each theme's schedule ranges.
 */
export function detectHolidayTheme(date: Date = new Date()): HolidayTheme | null {
  const month = date.getMonth() + 1
  const day = date.getDate()

  for (const theme of Object.values(THEMES)) {
    if (theme.name === 'default') continue
    for (const [m, start, end] of theme.schedule) {
      if (month === m && day >= start && day <= end) {
        return theme
      }
    }
  }
  return null
}

/**
 * Returns the active theme — holiday if in season, otherwise default.
 */
export function getActiveTheme(date: Date = new Date()): HolidayTheme {
  return detectHolidayTheme(date) ?? THEMES.default
}
