/**
 * @jest-environment jsdom
 *
 * The Filters header exposes a visible Reset button and the Formation Score
 * control starts at the shared default (50). Reset only mutates filter state —
 * it must never trigger a scan or a refresh request.
 */

import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScannerControls } from '@/components/scanner/ScannerControls';
import { DEFAULT_SCANNER_FILTERS } from '@/hooks/use-zones';

type ScannerControlsProps = ComponentProps<typeof ScannerControls>;

function makeProps(
  overrides: Partial<ScannerControlsProps> = {}
): ScannerControlsProps {
  return {
    filters: { ...DEFAULT_SCANNER_FILTERS },
    onFiltersChange: jest.fn(),
    onResetFilters: jest.fn(),
    onRunScan: jest.fn(),
    onRefreshZones: jest.fn(),
    isRunning: false,
    launching: false,
    isAuthenticated: true,
    ...overrides,
  };
}

describe('ScannerControls — filters', () => {
  test('shows Formation Score 50 and the default sort controls', () => {
    render(<ScannerControls {...makeProps()} />);

    expect(screen.getByText('Formation Score ≥ 50')).toBeTruthy();
    const slider = document.getElementById('min-score-slider') as HTMLInputElement;
    expect(slider.value).toBe('50');

    const sort = document.getElementById('sort-select') as HTMLSelectElement;
    expect(sort.value).toBe('score');
    expect(document.getElementById('dir-desc')?.getAttribute('data-active')).toBe('true');
  });

  test('the visible Reset button restores filters without starting a scan', () => {
    const props = makeProps({
      filters: {
        symbol: 'RELIANCE',
        timeframe: '1D',
        minScore: 80,
        sort: 'score',
        dir: 'asc',
      },
    });
    render(<ScannerControls {...props} />);

    fireEvent.click(screen.getByText('Reset filters'));

    expect(props.onResetFilters).toHaveBeenCalledTimes(1);
    expect(props.onRunScan).not.toHaveBeenCalled();
    expect(props.onRefreshZones).not.toHaveBeenCalled();
  });

  test('moving the Formation Score slider to 0 preserves the explicit 0', () => {
    const props = makeProps();
    render(<ScannerControls {...props} />);

    fireEvent.change(document.getElementById('min-score-slider')!, {
      target: { value: '0' },
    });

    expect(props.onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ minScore: 0, offset: 0 })
    );
  });

  test('a custom minScore is displayed instead of the default', () => {
    render(
      <ScannerControls
        {...makeProps({ filters: { ...DEFAULT_SCANNER_FILTERS, minScore: 75 } })}
      />
    );

    expect(screen.getByText('Formation Score ≥ 75')).toBeTruthy();
    const slider = document.getElementById('min-score-slider') as HTMLInputElement;
    expect(slider.value).toBe('75');
  });
});
