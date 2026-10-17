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

## Land, the watch, access and homes (settlement-rules/5)

- **Land.** A peasant family's holding was tens of acres (a virgate was about 30), and
  a three-field rotation left a third fallow each year, so a person needed one to two
  acres of land to be fed. Farmsteads stood in their own fields along the lanes, often
  well apart. The rules give each farm 1.5 acres per person it feeds (45 acres).
- **The watch.** Trouble came at the gates (strangers, tolls, smuggling, curfew), in
  the crowded market and in the poor streets, so that is where the watch stood. The
  constable or captain kept a watch house, and a town held offenders in a gaol (often
  by the town hall or in a gatehouse) for the stocks, a fine or the assizes.
- **Access.** A market place was open to every street that reached it; a church had a
  west door and a priest's door, a school one door, a gaol one guarded door.
- **Homes.** The poor shared: several families, lodgers and servants under one roof,
  tenements subdivided room by room. Workshops and stores that stank, burned or drew
  carts were kept out of the residential streets.

| History | In the rules |
| --- | --- |
| Holdings of tens of acres | `Parcel.holding`, `farming.acresPerPersonX10` 15, gate `farm_acreage` |
| Watch at gates, market, poor streets | `rules.watch`, `Parcel.post`, `Parcel.wealth`, gate `town_watch` |
| Watch house and gaol | `watch_hq`, `gaol` side by side at the back of the civic quarter |
| Open market, controlled church | `entrances`, `capacity`, `minAccess`, gate `access_capacity` |
| Shared homes, tenements | `house` 2 households, `tenement` 3, `familiesPerHomeX10`, `homeSpacePermille` |
| Stores and works away from homes | warehouses with the crafts, `worksBufferMm`, gate `works_separation` |

## Mastery (our world, not history)

In this world anyone can master a profession, roughly one person in a hundred, and a
community can be full of masters. A master's work counts four times: a master farm
feeds four times as many people from a quarter of the land, and a master smith or
craftsman does the work of four workshops. Towns with masters draw people. More
residents settle there, and traders, buyers and would-be apprentices pass through,
filling extra taverns and inns. Every master is a named NPC at their workplace with
apprentices beside them, so players can seek them out to learn.

## Where people live and who has the best land (settlement-rules/6)

- **Not everyone had a home.** Every town had people with nowhere to live: beggars,
  vagrants, widows and orphans, and day labourers between employers. Hospitals (often
  almshouses), monasteries and church porches took some of them in. In the generator, 1 to
  3 in 100 people in a town of 150 or more are homeless, more in a crowded town, sheltering
  at those buildings where the town has them.
- **Size followed access.** Moving goods by water cost a fraction of hauling them overland,
  so ports and river towns could feed and supply far more people than inland towns. Places
  off the roads, or on poor land, stayed small. Crowded towns packed families into
  tenements, while sparse ones kept gardens, yards and orchards between the houses. Since
  ground travel is the norm in this world, the generator caps each town by its access
  (port, river, road or remote) and draws its density from a range for that access.
- **The best land went to those who could pay for it.** Master farmers and craftsmen sold
  sought-after goods at good prices and could afford the land nearest the walls and the
  market, safer from bandits and wild animals. Ordinary farms lay farther out. Remote towns
  attracted few masters at all.
- **Grand masters (our world).** A rare master's fame draws pupils who pay to learn for
  years. They settle in the town, which grows around that one discipline in the grand
  master's honour.

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
