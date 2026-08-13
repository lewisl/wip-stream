# Changelog

## 0.1.6

- Initialize Stream now safely gets current from the remote and starts the first editing session automatically.
- Its complete Output record explains that later editing sessions must begin with Get Current from Remote.

## 0.1.5

- Renamed the Command Palette titles to **Save to Remote** and **Get Current from Remote**; command IDs remain unchanged.

## 0.1.4

- Resume now synchronizes a clone after another machine completes its feature, leaving the clone on current `main` and removing completed temporary branches.
- Improved the isolated two-computer live test to verify that final synchronization.

## 0.1.0

- Initial local-VSIX release of WipStream.
- Added explicit `init`, `resume`, `saveup`, `tofeature`, and `tomain` commands.
