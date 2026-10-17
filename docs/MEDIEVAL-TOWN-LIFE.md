# Medieval town and church life: what the settlement generator draws on

A working note for the settlement rules (`packages/settlement`, [`SETTLEMENTS.md`](SETTLEMENTS.md)
"Town plan"). It sums up how a high-medieval European village or market town was
usually organised, what of that the generator already bakes in, and what to build
next. It is a summary of widely known history, not a sourced study; where real towns
varied a lot, the rules keep the number as data so a game can change it.

## How a town was laid out

- **The crossing and the square.** Towns grew at a road crossing, a bridge or a
  ford. The market square sat where the main roads met; around it stood the
  parish church, the town hall (or guild hall), the better merchants' houses and
  the inns that served market days. A village had a green instead: a common open
  space with a well or pond, the church beside it.
- **Trades in their own streets.** Shops and workshops of one trade clustered
  (Butchers' Row, Smith Street). Noisy, smelly and fire-prone crafts (smiths,
  tanners, dyers, potters, lime burners) were pushed to the edge or outside the
  walls, near water and the roads they traded along. Mills stood on rivers or
  windy rises outside.
- **Inns by the gates.** Travellers came in through the gates, so inns, stables and
  taverns gathered along the main road just inside them. The bathhouse
  ("stews") was often near the water or the edge of town.
- **Walls, gates and the watch.** A wall was a privilege granted to a town, not
  to a house: a ring with towers and a few gates, shut at curfew. Gates were
  manned by the watch, who also walked the streets at night. Larger towns kept
  a garrison or a castle. Villages had no wall; the constable and the hue and cry
  kept order.
- **Fields outside.** Most people, even in towns, lived off the land. Open fields
  in strips surrounded the settlement along the roads out; farmers lived in the
  village itself or in farmsteads along the lanes. Common pasture and woodland lay
  beyond.
- **Suburbs.** As towns grew, houses and workshops spilled out beyond the gates
  along the roads (faubourgs): poorer trades, inns for carters, hospitals for
  lepers and travellers.

## Church life

- **The parish was the unit of life.** Every village had a church or chapel; a
  town had one parish church per few hundred to a couple of thousand people, each
  with its own churchyard. The church was the largest building most people knew,
  usually stone when everything else was timber, and its tower was the landmark
  seen from the fields.
- **The churchyard** was the burial ground and also a meeting and market place;
  it adjoined the church. The priest lived beside it in the rectory or vicarage
  and was supported by the tithe (a tenth of produce, stored in a tithe barn).
- **The bells kept time.** The canonical hours (matins at dawn, terce, sext at
  noon, nones, vespers, compline at dusk) and the curfew bell structured the day:
  work, markets and gate opening followed them.
- **Charity and care were the church's work.** Hospitals were church foundations:
  almshouses for the old and poor, infirmaries for the sick, hostels for
  pilgrims, and leper houses (lazar houses) outside the walls. Monks and nuns
  were the medical people of most places; apothecaries and barber-surgeons
  served the towns.
- **Monasteries** stood apart, usually outside the town on their own estates,
  farming them with lay brothers and tenants, and running schools, scriptoria
  and hospitals. A cathedral marked a bishop's city and dominated it.
- **Feast days and the church year** set the calendar: Sundays, saints' days,
  Lent and Easter, harvest; fairs were often held on a patron saint's day.
- **Schooling** was mostly church-run: a song or grammar school attached to a
  church or monastery; towns of size added a guild or town school.

## What the generator does with this (settlement-rules/4)

| History | In the rules |
| --- | --- |
| Square at the crossing, green in a village | `square`: the block where the primary roads meet, a well at its centre |
| Church, town hall, watch on the square | civic quarter grown first from the square: `parish_church`, `rectory`, `town_hall`, `guardhouse`, `hospital`; their plots are the ones nearest the square |
| Market round the square | shopping quarter (`market`, `bakery`, `apothecary`, `granary`, `warehouse`) next |
| Inns by the gate | entertainment quarter grown from one gate in along the main road (`tavern`, `inn`, `theatre`, `bathhouse`) |
| Church schools near the centre | education quarter (`school`, `library`) |
| Dirty trades outside | craft quarter (`smithy`, `workshop`, `mill`, `warehouse`) lines one road out beyond the wall |
| Fields along the roads | farms on both sides of the four roads out, sized to feed the town |
| A wall is the town's | towns of 45+ households get a towered ring with four gates; villages are open |
| Parish chapels, churchyards | `chapel` and `churchyard` also stand among the homes |
| Monastery on its own lands | `monastery` stands among the farms (1000+ people) |
| Cathedral city, garrison | `cathedral` (2000+), `barracks` (1200+) |
| A village: one school, one tavern | quarters are sized by required buildings; `minPopulation` keeps halls, theatres and libraries out of villages |
| Taverns not on every street | `maxPerPopulation` ceilings |

## Next steps worth building

1. **The day by the bells**: give residents (occupancy NPCs) a schedule from the
   canonical hours: work from terce to vespers, market mornings, church on
   Sundays, curfew at compline when the gates close and the watch walks.
2. **Market days and fairs** on a weekly and yearly calendar: stalls fill the
   square, traders come in through the gates.
3. **Guild streets**: inside the market and craft quarters, keep one trade to a
   street (all bakers on one frontage) with a guild hall.
4. **Leper house and pilgrims' hostel** outside the walls on a road out; a tithe
   barn by the church.
5. **Water**: mills, tanners and dyers onto the river side when the site has one;
   the bathhouse by the water.
6. **Parishes**: split a large town's housing into parishes, each with its
   chapel and churchyard, and give each NPC a parish.
7. **Inner walls**: a castle or cathedral close walled off inside a city.
