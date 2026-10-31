# Mistral AI

## Présentation

Cette intégration fait tourner l’assistant de Gladys sur **Mistral AI**, l’IA française, via son API officielle (La Plateforme, hébergée en Europe) et votre propre clé d’API. Une fois choisie dans **Paramètres → Intelligence artificielle**, chaque requête d’IA de Gladys part chez Mistral : le chat et les appareils qu’il pilote, les scènes qu’il crée, l’action de scène « demander à l’IA » et le résumé hebdomadaire. Elle fonctionne avec ou sans compte Gladys Plus.

Elle ajoute aussi une action de scène qui pose une question à Mistral **avec recherche web**, deux déclencheurs de scène (l’assistant est en erreur, l’assistant répond de nouveau) et un widget de tableau de bord de votre consommation.

Sans lien avec Mistral AI. Pas encore testée avec une vraie clé Mistral : vos retours sont bienvenus.

## Prérequis

- Gladys Assistant 5.3.0 ou plus récent.
- Un compte Mistral et une clé d’API : [console.mistral.ai](https://console.mistral.ai/api-keys), **Clés d’API** → **Créer une nouvelle clé**.
- **Offre gratuite Experiment** : environ une requête par seconde et un budget mensuel de jetons ; Mistral peut utiliser vos requêtes pour améliorer ses modèles (vérifiez les réglages de confidentialité de votre organisation dans la console). **Offre Scale** (paiement à l’usage) : limites plus hautes, pas d’entraînement sur vos données.
- Ce qui sort de chez vous : chaque message du chat, l’historique, les outils que Gladys propose et leurs résultats (l’état des appareils que Mistral consulte) et les images du chat partent chez Mistral en HTTPS. Les réponses de Mistral pilotent vos appareils et créent des scènes.

## Configuration

| Champ ou bouton                          | Par défaut      | Rôle                                                                                                     |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| Clé d’API Mistral                        | —               | Obligatoire. Plus jamais affichée, jamais journalisée                                                    |
| Modèle du chat                           | Mistral Large 4 | Répond au chat, crée les scènes, rédige le résumé hebdomadaire, fait la recherche web                    |
| Modèle du routeur                        | Ministral 3 8B  | Trie chaque message avant la réponse et doit répondre en moins de 20 secondes                            |
| Identifiant de l’autre modèle            | —               | Seulement si un modèle est réglé sur « Autre modèle » : l’identifiant exact (il doit appeler des outils) |
| Réflexion du modèle du chat              | Moyenne         | Plus de réflexion, de meilleures scènes, des réponses plus lentes                                        |
| Longueur maximale d’une réponse (jetons) | 8000            | Réflexion comprise                                                                                       |
| Tester la connexion                      | —               | Une réponse courte de chaque modèle avec son temps ; consomme quelques jetons                            |

Le statut de l’écran de configuration indique si Mistral accepte la clé et les deux modèles, sans consommer de jeton, et prévient quand un modèle ne sait pas appeler d’outils.

## Utilisation

1. Intégrations → **Mistral AI** → Configuration : collez la clé d’API, gardez les modèles par défaut, appuyez sur **Tester la connexion**.
2. Paramètres → **Intelligence artificielle** : choisissez **Mistral AI**.
3. Parlez à Gladys dans le chat : « allume le salon », « quelle température dans la chambre ? », « crée une scène qui ferme les volets au coucher du soleil ».

### Choisir les modèles

- **Mistral Large 4** (par défaut pour le chat) : le plus capable, le meilleur pour créer des scènes ; il réfléchit toujours (faible, moyenne ou élevée).
- **Mistral Small 4** : plus rapide et moins cher ; réflexion désactivée ou élevée.
- **Ministral 3** (14B, 8B, 3B) : petits et rapides, sans réflexion ; Ministral 3 8B est le routeur par défaut. Ils sont moins fiables pour créer des scènes.
- **Autre modèle** : un modèle Mistral plus récent ou l’un de vos modèles affinés. S’il refuse le paramètre de réflexion, l’intégration l’envoie sans, désormais.

### Widget de tableau de bord

Le widget **Conso Mistral** affiche les requêtes et jetons du jour, les jetons du mois, les erreurs du jour, les jetons par jour sur 30 jours, si Mistral répond, la dernière requête et la dernière erreur. Il compte ce que Gladys a demandé ; la console Mistral reste la référence pour la facture.

![Le widget de consommation : requêtes et jetons du jour, jetons du mois, erreurs, jetons par jour, dernière requête et dernière erreur (illustration générée, pas une capture d’écran)](https://raw.githubusercontent.com/William-De71/gladys-mistral-ai/main/docs/assets/widgets.fr.png)

### Scènes

- **Action « Mistral : demander avec recherche web »** : Mistral cherche sur le web et répond en quelques phrases. Champs : la question (variables de scène acceptées), des consignes en plus, les agences de presse (recherche premium). Sorties : la réponse et les sources, une par ligne.
- **Déclencheur « Mistral : l’assistant est en erreur »** : une fois par panne (clé refusée, limite de requêtes, modèle indisponible, API injoignable, trop lent, erreur Mistral), avec le type, le message, la requête et le modèle.
- **Déclencheur « Mistral : l’assistant répond de nouveau »** : la première réponse après une panne, avec les minutes de panne.

Exemples : chaque matin, demander avec recherche web les actualités du jour et envoyer la réponse par Telegram ; quand l’assistant est en erreur avec une clé refusée, envoyer un SMS à l’administrateur.

## Dépannage

- **« Mistral a refusé la clé d’API »** : recopiez la clé depuis la console ; une clé supprimée ou expirée donne le même message.
- **« Limite de requêtes atteinte »** : l’offre gratuite accepte environ une requête par seconde. L’intégration réessaie dans le délai que Gladys accorde ; si cela revient souvent, passez à l’offre Scale ou choisissez un modèle de routeur plus petit.
- **« … n’est pas disponible pour cette clé d’API »** : le modèle n’existe pas ou n’est pas ouvert à votre offre ; choisissez-en un autre.
- **Le chat répond sans rien faire** : le modèle choisi ne sait peut-être pas appeler d’outils (voir le statut), ou la réflexion est désactivée sur un petit modèle ; essayez Mistral Large 4.
- **« La réponse a été coupée à max_tokens »** : augmentez la longueur maximale d’une réponse.
- **Une image du chat échoue** : le modèle choisi ne lit peut-être pas les images ; les modèles Mistral de la liste les lisent tous.
- Journaux : Paramètres → Supervision, les journaux de l’intégration. Ne partagez jamais votre clé d’API.
