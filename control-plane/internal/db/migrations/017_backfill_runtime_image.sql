-- Rattache une image de référence aux types installés avant la 016.
--
-- Sans elle, le sélecteur de version retombe sur la liste figée du dossier :
-- trois entrées datées, là où le registre en publie des dizaines. Les types
-- installés avant l'ajout de la colonne restaient donc muets, sans que rien ne
-- l'explique à l'utilisateur.
--
-- Le rapprochement se fait sur le nom, seul indice disponible. Un dossier
-- renommé n'est pas rattrapé : il reste modifiable à la main.

UPDATE template_folders SET runtime_image = 'node'
 WHERE is_golden_path AND runtime_image = '' AND name ILIKE '%node%';

UPDATE template_folders SET runtime_image = 'python'
 WHERE is_golden_path AND runtime_image = '' AND name ILIKE '%python%';

UPDATE template_folders SET runtime_image = 'golang'
 WHERE is_golden_path AND runtime_image = ''
   AND (name ILIKE '%go%' AND name NOT ILIKE '%mongo%');
