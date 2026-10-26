/**
 * @jest-environment jsdom
 *
 * Page-level filter contract:
 *  - the first zones request already applies Formation Score >= 50;
 *  - any filter change returns to page 1;
 *  - Reset restores every default (including minScore 50 and page 1) and never
 *    starts, resumes, or cancels a scan.
 */

import { fireEvent, render, screen } from '@testing-library/react';

const mockUseZones = jest.fn();
const mockRefetch = jest.fn();
const mockLaunch = jest.fn();
const mockResetJob = jest.fn();

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    status: { authenticated: true },
    loading: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

jest.mock('@/hooks/use-zones', () => {
  const actual = jest.requireActual('@/hooks/use-zones');
  return {
    ...actual,
    useZones: (...args: unknown[]) => mockUseZones(...args),
  };
});

jest.mock('@/hooks/use-scanner-job', () => ({
  useScannerJob: () => ({
    job: null,
    batches: { completed: 0, failed: 0, total: 0 },
    launching: false,
    resuming: false,
    launch: mockLaunch,
    reset: mockResetJob,
  }),
}));

jest.mock('@/components/header', () => ({ Header: () => null }));
jest.mock('@/components/scanner/ScanProgress', () => ({
  ScanProgress: () => null,
}));
jest.mock('@/components/scanner/ZoneTable', () => ({
  ZoneTable: () => null,
}));
jest.mock('@/components/scanner/ZoneDetailDrawer', () => ({
  ZoneDetailDrawer: () => null,
}));

import ScannerPage from '@/app/scanner/page';

function lastFilters() {
  const calls = mockUseZones.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  mockUseZones.mockReset();
  mockUseZones.mockReturnValue({
    zones: [],
    count: 250,
    loading: false,
    error: null,
    refetch: mockRefetch,
  });
  mockLaunch.mockReset();
  mockResetJob.mockReset();
  mockRefetch.mockReset();
});

describe('ScannerPage — default filters and Reset', () => {
  test('initial zones query applies Formation Score 50 on page 1', () => {
    render(<ScannerPage />);

    expect(mockUseZones).toHaveBeenCalled();
    expect(lastFilters()).toEqual({
      minScore: 50,
      sort: 'score',
      dir: 'desc',
      limit: 100,
      offset: 0,
    });
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
  });

  test('filter changes reset pagination and Reset restores every default', () => {
    render(<ScannerPage />);

    fireEvent.click(screen.getByText('Next →'));
    expect(lastFilters()).toMatchObject({ offset: 100 });
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();

    // Changing a non-score filter returns to page 1 and keeps the rest.
    fireEvent.click(document.getElementById('tf-1D')!);
    expect(lastFilters()).toMatchObject({ timeframe: '1D', offset: 0, minScore: 50 });
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();

    fireEvent.change(document.getElementById('min-score-slider')!, {
      target: { value: '0' },
    });
    expect(lastFilters()).toMatchObject({ minScore: 0, timeframe: '1D', offset: 0 });

    fireEvent.click(screen.getByText('Next →'));
    expect(lastFilters()).toMatchObject({ offset: 100 });

    fireEvent.click(screen.getByText('Reset filters'));

    expect(lastFilters()).toEqual({
      minScore: 50,
      sort: 'score',
      dir: 'desc',
      limit: 100,
      offset: 0,
    });
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();

    // Reset only changes list-query state.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockResetJob).not.toHaveBeenCalled();
  });
});
