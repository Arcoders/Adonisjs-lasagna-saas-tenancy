/** Builds widgets. */
export default class WidgetService {
  /** Assemble a widget of a given size. */
  build(name: string, size: number): string {
    if (size < 0) throw new RangeError('bad size')
    return name
  }

  reset(): void {}
}
