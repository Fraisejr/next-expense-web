const DEFAULT_CATEGORY_COLOR = '#5D7D91'

const supportedIconKeys = new Set([
  'banknote', 'basket', 'briefcase', 'car', 'credit-card', 'dumbbell', 'heart',
  'house', 'medical', 'plane', 'receipt', 'shield', 'shopping-bag', 'sparkles',
  'target', 'tv', 'utensils', 'wine', 'zap',
])

const sfSymbolIconKeys: Record<string, string> = {
  'briefcase.fill': 'briefcase',
  'banknote.fill': 'banknote',
  'cart.fill': 'basket',
  'wineglass.fill': 'wine',
  'play.tv.fill': 'tv',
  'house.fill': 'house',
  'exclamationmark.shield.fill': 'shield',
  'bag.fill': 'shopping-bag',
  'bolt.fill': 'zap',
  target: 'target',
  'car.fill': 'car',
  'cross.case.fill': 'medical',
  'creditcard.fill': 'credit-card',
  airplane: 'plane',
  'fork.knife': 'utensils',
}

export function normalizeCategoryColor(value: unknown) {
  const color = typeof value === 'string' ? value.trim() : ''
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase()
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color.toUpperCase()}`
  return DEFAULT_CATEGORY_COLOR
}

export function normalizeCategoryIcon(value: unknown, categoryName: string) {
  const icon = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (supportedIconKeys.has(icon)) return icon
  if (sfSymbolIconKeys[icon]) return sfSymbolIconKeys[icon]

  const name = categoryName.toLowerCase()
  if (/salary|business/.test(name)) return 'briefcase'
  if (/income|saving|dividend|investment|emergency fund/.test(name)) return 'banknote'
  if (/grocer/.test(name)) return 'basket'
  if (/going out|per diem/.test(name)) return 'utensils'
  if (/leisure/.test(name)) return 'tv'
  if (/transport|car/.test(name)) return 'car'
  if (/apartment|rent/.test(name)) return 'house'
  if (/insurance/.test(name)) return 'shield'
  if (/shopping/.test(name)) return 'shopping-bag'
  if (/utilit/.test(name)) return 'zap'
  if (/cleaning/.test(name)) return 'target'
  if (/gym/.test(name)) return 'dumbbell'
  if (/medical/.test(name)) return 'medical'
  if (/subscription/.test(name)) return 'credit-card'
  if (/travel/.test(name)) return 'plane'
  if (/tax|fee|expense/.test(name)) return 'receipt'
  if (/charity/.test(name)) return 'heart'
  return 'sparkles'
}
