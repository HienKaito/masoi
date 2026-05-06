# Adding Roles

Role metadata now lives in `shared/roleRegistry.js` and is loaded by both Node and the browser.

## Basic Role

For a role with no custom action, add one object to `roles` in `shared/roleRegistry.js`:

```js
{
    id: 'HUNTER',
    settingsKey: 'hunter',
    team: 'VILLAGE',
    alignment: 'GOOD',
    name: 'Thợ Săn',
    color: '#f59e0b',
    description: 'Phe Dân Làng...'
}
```

Then add the matching stepper in `public/index.html` using `id="count-hunter"` and `data-input="count-hunter"`.

## Role With Night Action

Set `hasNightAction: true` in the registry. The server will automatically emit `yourTurn` at night for alive players with that role.

You still need to implement the role-specific behavior in two places:

- Server validation and state changes in `game/GameLogic.js#handleAction`.
- Client target selection and click behavior in `public/app.js#renderPlayersGrid`.

## Wolf-Aligned Role

Set these fields:

```js
team: 'WEREWOLF',
alignment: 'EVIL',
isWolfRole: true,
hasNightAction: true
```

The server/client will automatically treat the role as wolf-aligned for chat, role reveal to wolves, night turn activation, and wolf-team checks.
