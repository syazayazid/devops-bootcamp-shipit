import { ship } from './config.js';
import './style.css';

const app = document.getElementById('app');
app.textContent = `${ship.shipName} · ${ship.color} · ${ship.emblem}`;
