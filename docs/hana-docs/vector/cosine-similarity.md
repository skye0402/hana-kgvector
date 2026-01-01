COSINE\_SIMILARITY Function (Vector)
====================================

Computes the cosine similarity of two vectors.

Syntax
------

    COSINE_SIMILARITY(<vector1>, <vector2>)

Syntax Elements
---------------

<vector1>

Specifies the first vector.

<vector2>

Specifies the second vector.

Description
-----------

Computes the cosine of the angle between <vector1> and <vector2>, comparing the direction of the vectors. Both vectors must have the same dimension.

The result is a DOUBLE number between -1 and 1. The greater the result, the more similar are the vectors.

For two vectors u and v, the cosine similarity is mathematically defined as follows:

![](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/loio82369b1e59f04f409bd1de9b9f188435_LowRes.svg)

Examples
--------

The following example returns 0.5:

    SELECT COSINE_SIMILARITY(
        TO_REAL_VECTOR('[1, 0, 0]'),
        TO_REAL_VECTOR('[0.5, 0.8660254, 0]'))
    FROM DUMMY;

The following example returns 0.499919672300608:

    SELECT COSINE_SIMILARITY(
        TO_HALF_VECTOR('[1, 0, 0]'),
        TO_HALF_VECTOR('[0.5, 0.8660254, 0]'))
    FROM DUMMY;

Related Information